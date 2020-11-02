import { ResourceMeta } from '@dot-i/k8s-operator';
import Connection from '~/connection';
import { CreateDatabaseResult, Postgres } from '~/databases';
import { kind2plural, getGroupName } from '~/util';
import {
  ConnectionPostgresResource,
  ExternalDatabaseStatusDatabase,
  ExternalPostgresResource,
  ExternalPostgresStatus,
  KustomizationResource
} from '~/types';
import {
  KustomizeResourceGroup,
  KustomizeResourceKind,
  KustomizeResourceVersion,
  ResourceKind,
  ResourceVersion
} from '~/externaldbOperator';
import ExternalDatabase from './externalDatabase';

export default class ExternalPostgres extends ExternalDatabase {
  async deleted(
    resource: ExternalPostgresResource,
    _meta: ResourceMeta
  ): Promise<any> {
    if (!resource.spec?.name) return;
    const connectionResource = await this.getConnectionResource(resource);
    if (!connectionResource?.spec?.password) return;
    const { database, url } = await this.getConnection(connectionResource);
    if (
      resource.status?.database !== ExternalDatabaseStatusDatabase.Created ||
      !resource.spec.cleanup
    ) {
      return;
    }
    this.spinner.start(`dropping database '${database}'`);
    const postgres = new Postgres({ connectionString: url });
    postgres.spinner = this.spinner;
    await postgres.dropDatabase(resource.spec.name);
    this.spinner.succeed(`dropped database '${database}'`);
  }

  async addedOrModified(
    resource: ExternalPostgresResource,
    _meta: ResourceMeta
  ): Promise<any> {
    if (!resource.spec?.name) return;
    const connectionResource = await this.getConnectionResource(resource);
    if (!connectionResource?.spec?.password) return;
    const { database, url } = await this.getConnection(connectionResource);
    const status = await this.getStatus(resource);
    if (status?.database) return;
    this.spinner.start(`creating database '${database}'`);
    try {
      await this.updateStatus(
        {
          database: ExternalDatabaseStatusDatabase.Creating
        },
        resource
      );
      const postgres = new Postgres({ connectionString: url });
      postgres.spinner = this.spinner;
      const result = await postgres.createDatabase(resource.spec.name);
      if (result === CreateDatabaseResult.AlreadyExists) {
        this.spinner.warn(`database '${database}' already exists`);
      } else {
        this.spinner.succeed(`created database '${database}'`);
      }
      await this.createOrUpdateConnectionResources(
        resource,
        connectionResource
      );
      if (resource.spec.kustomization) await this.applyKustomization(resource);
      await this.updateStatus(
        {
          database:
            result === CreateDatabaseResult.AlreadyExists
              ? ExternalDatabaseStatusDatabase.AlreadyExists
              : ExternalDatabaseStatusDatabase.Created
        },
        resource
      );
    } catch (err) {
      await this.updateStatus(
        {
          database: ExternalDatabaseStatusDatabase.Failed
        },
        resource
      );
      throw err;
    }
  }

  async applyKustomization(resource: ExternalPostgresResource): Promise<void> {
    if (!resource.metadata?.name || !resource.metadata.namespace) return;
    try {
      await this.customObjectsApi.getNamespacedCustomObject(
        getGroupName(KustomizeResourceGroup.Kustomize),
        KustomizeResourceVersion.V1alpha1,
        resource.metadata.namespace,
        kind2plural(KustomizeResourceKind.Kustomization),
        resource.metadata.name
      );
      await this.customObjectsApi.patchNamespacedCustomObject(
        getGroupName(KustomizeResourceGroup.Kustomize),
        KustomizeResourceVersion.V1alpha1,
        resource.metadata.namespace,
        kind2plural(KustomizeResourceKind.Kustomization),
        resource.metadata.name,
        [
          {
            op: 'replace',
            path: '/spec',
            value: resource.spec?.kustomization
          }
        ],
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/json-patch+json' }
        }
      );
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      const kustomizationResource: KustomizationResource = {
        metadata: {
          name: resource.metadata.name,
          namespace: resource.metadata.namespace
        },
        spec: resource.spec?.kustomization
      };
      await this.customObjectsApi.createNamespacedCustomObject(
        getGroupName(KustomizeResourceGroup.Kustomize),
        KustomizeResourceVersion.V1alpha1,
        resource.metadata.namespace,
        kind2plural(KustomizeResourceKind.Kustomization),
        kustomizationResource
      );
    }
  }

  async updateStatus(
    status: ExternalPostgresStatus,
    resource: ExternalPostgresResource
  ): Promise<void> {
    if (!resource.metadata?.name || !resource.metadata.namespace) return;
    await this.customObjectsApi.patchNamespacedCustomObjectStatus(
      this.group,
      ResourceVersion.V1alpha1,
      resource.metadata.namespace,
      this.plural,
      resource.metadata.name,
      [
        {
          op: 'replace',
          path: '/status',
          value: status
        }
      ],
      undefined,
      undefined,
      undefined,
      {
        headers: { 'Content-Type': 'application/json-patch+json' }
      }
    );
  }

  async getConnectionResource(
    resource: ExternalPostgresResource
  ): Promise<ConnectionPostgresResource | undefined> {
    if (
      !resource.metadata?.name ||
      !resource.metadata.namespace ||
      !resource.spec?.connection?.name
    ) {
      return;
    }
    const namespace =
      resource.spec?.connection?.namespace || resource.metadata.namespace;
    try {
      const connectionPostgres = (
        await this.customObjectsApi.getNamespacedCustomObject(
          this.group,
          ResourceVersion.V1alpha1,
          namespace,
          kind2plural(ResourceKind.ConnectionPostgres),
          resource.spec.connection.name
        )
      ).body as ConnectionPostgresResource;
      return connectionPostgres;
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  async getConnection(
    connectionResource: ConnectionPostgresResource
  ): Promise<Connection> {
    let database = connectionResource.spec?.database;
    let hostname = connectionResource.spec?.hostname;
    let password = connectionResource.spec?.password;
    let port = connectionResource.spec?.port;
    let url = connectionResource.spec?.url;
    let username = connectionResource.spec?.username;
    if (
      connectionResource.metadata?.namespace &&
      connectionResource.spec?.configMapName
    ) {
      if (connectionResource.spec?.configMapName) {
        try {
          const configMap = (
            await this.coreV1Api.readNamespacedConfigMap(
              connectionResource.spec.configMapName,
              connectionResource.metadata.namespace
            )
          ).body;
          if (configMap.data?.POSTGRES_DATABASE) {
            database = configMap.data.POSTGRES_DATABASE;
          }
          if (configMap.data?.POSTGRES_PORT) {
            const postgresPort = Number(configMap.data.POSTGRES_PORT);
            if (!isNaN(postgresPort)) port = postgresPort;
          }
          if (configMap.data?.POSTGRES_USERNAME) {
            username = configMap.data.POSTGRES_USERNAME;
          }
          if (configMap.data?.POSTGRES_HOSTNAME) {
            hostname = configMap.data.POSTGRES_HOSTNAME;
          }
        } catch (err) {
          if (err.statusCode !== 404) throw err;
        }
      }
      if (connectionResource.spec.secretName) {
        try {
          const secret = (
            await this.coreV1Api.readNamespacedSecret(
              connectionResource.spec.secretName,
              connectionResource.metadata.namespace
            )
          ).body;
          if (secret.stringData?.POSTGRES_PASSWORD) {
            password = secret.stringData.POSTGRES_PASSWORD;
          }
          if (secret.stringData?.POSTGRES_URL) {
            url = secret.stringData.POSTGRES_URL;
          }
        } catch (err) {
          if (err.statusCode !== 404) throw err;
        }
      }
    }
    return new Connection(
      url || {
        username: username || 'postgres',
        password,
        hostname,
        port: port || 3306,
        database: database || 'postgres'
      }
    );
  }

  async createOrUpdateConnectionResources(
    resource: ExternalPostgresResource,
    connectionResource: ConnectionPostgresResource
  ): Promise<void> {
    if (
      !resource.metadata?.name ||
      !resource.metadata.namespace ||
      !resource.spec?.name
    ) {
      return;
    }
    const connection = await this.getConnection(connectionResource);
    const clonedConnection = new Connection({
      database: resource.spec.name,
      hostname: connection.hostname,
      password: connection.password,
      port: connection.port,
      username: connection.username
    });
    const {
      database,
      hostname,
      password,
      port,
      url,
      username
    } = clonedConnection;
    const configMapName = resource.spec.configMapName || resource.metadata.name;
    const secretName = resource.spec.secretName || resource.metadata.name;
    const configMap = {
      PORT: (port || 5432).toString(),
      USERNAME: username || 'postgres',
      ...(database ? { DATABASE: database } : {}),
      ...(hostname ? { HOSTNAME: hostname } : {})
    };
    const secret = {
      ...(password ? { PASSWORD: password } : {}),
      ...(url ? { URL: url } : {})
    };
    try {
      await this.coreV1Api.readNamespacedSecret(
        secretName,
        resource.metadata.namespace
      );
      await this.coreV1Api.patchNamespacedSecret(
        secretName,
        resource.metadata.namespace,
        [
          {
            op: 'replace',
            path: '/stringData',
            value: secret
          }
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/json-patch+json' }
        }
      );
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      await this.coreV1Api.createNamespacedSecret(resource.metadata.namespace, {
        metadata: {
          name: secretName,
          namespace: resource.metadata.namespace
        },
        stringData: secret
      });
    }
    try {
      await this.coreV1Api.readNamespacedConfigMap(
        configMapName,
        resource.metadata.namespace
      );
      await this.coreV1Api.patchNamespacedConfigMap(
        configMapName,
        resource.metadata.namespace,
        [
          {
            op: 'replace',
            path: '/data',
            value: configMap
          }
        ],
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/json-patch+json' }
        }
      );
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      await this.coreV1Api.createNamespacedConfigMap(
        resource.metadata.namespace,
        {
          metadata: {
            name: configMapName,
            namespace: resource.metadata.namespace
          },
          data: configMap
        }
      );
    }
  }

  async getStatus(
    resource: ExternalPostgresResource
  ): Promise<ExternalPostgresStatus | undefined> {
    if (!resource.metadata?.name || !resource.metadata.namespace) return;
    const body = (
      await this.customObjectsApi.getNamespacedCustomObjectStatus(
        this.group,
        ResourceVersion.V1alpha1,
        resource.metadata.namespace,
        this.plural,
        resource.metadata.name
      )
    ).body as ExternalPostgresResource;
    return body.status;
  }
}
