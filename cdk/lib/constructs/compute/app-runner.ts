import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { IamRole } from '../security/iam-role';

export interface AppRunnerProps {
  /** Full ECR image URI including tag. */
  readonly imageUri: string;
  /** Log group where App Runner forwards application logs via CloudWatch. */
  readonly logGroup: logs.ILogGroup;
  /**
   * Instance role — the IAM role the running container assumes.
   * Must grant access to S3 and DynamoDB.
   */
  readonly instanceRole: iam.IRole;
  /** Environment variables injected into the container at runtime. */
  readonly environment: Record<string, string>;
  /**
   * Container port.
   * @default 8000
   */
  readonly containerPort?: number;
  /**
   * vCPU allocation for each App Runner instance.
   * Valid values: '0.25 vCPU', '0.5 vCPU', '1 vCPU', '2 vCPU', '4 vCPU'.
   * @default '0.25 vCPU'
   */
  readonly cpu?: string;
  /**
   * Memory allocation for each App Runner instance.
   * Must be compatible with the chosen cpu value — see App Runner pricing page.
   * @default '0.5 GB'
   */
  readonly memory?: string;
  /**
   * Seconds between health check requests.
   * @default 10
   */
  readonly healthCheckIntervalSeconds?: number;
  /**
   * Seconds before a health check times out.
   * @default 5
   */
  readonly healthCheckTimeoutSeconds?: number;
  /**
   * Consecutive healthy checks required before marking the service healthy.
   * @default 1
   */
  readonly healthyThreshold?: number;
  /**
   * Consecutive failed checks required before marking the service unhealthy.
   * @default 5
   */
  readonly unhealthyThreshold?: number;
}

/**
 * An App Runner service that pulls a container image from ECR.
 *
 * App Runner manages provisioning, scaling, and TLS termination.
 * No VPC or ALB configuration required for this target.
 *
 * An ECR access role is created internally — callers only provide the instance role.
 */
export class AppRunner extends Construct {
  /** The App Runner service URL (without the https:// prefix). */
  public readonly serviceUrl: string;
  /** The App Runner service ARN. */
  public readonly serviceArn: string;

  constructor(scope: Construct, id: string, props: AppRunnerProps) {
    super(scope, id);

    // App Runner needs this role to authenticate with ECR and pull the image.
    const ecrAccessRole = new IamRole(this, 'EcrAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      description: 'Allows App Runner to pull images from ECR',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSAppRunnerServicePolicyForECRAccess',
        ),
      ],
    });

    const environmentVariables = Object.entries(props.environment).map(
      ([name, value]) => ({ name, value }),
    );

    // App Runner L1 construct — no stable L2 is available in aws-cdk-lib.
    const service = new apprunner.CfnService(this, 'Service', {
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: ecrAccessRole.role.roleArn,
        },
        imageRepository: {
          imageIdentifier: props.imageUri,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: String(props.containerPort ?? 8000),
            runtimeEnvironmentVariables: environmentVariables,
          },
        },
        autoDeploymentsEnabled: false,
      },
      instanceConfiguration: {
        instanceRoleArn: props.instanceRole.roleArn,
        cpu: props.cpu ?? '0.25 vCPU',
        memory: props.memory ?? '0.5 GB',
      },
      healthCheckConfiguration: {
        protocol: 'HTTP',
        path: '/health',
        interval: props.healthCheckIntervalSeconds ?? 10,
        timeout: props.healthCheckTimeoutSeconds ?? 5,
        healthyThreshold: props.healthyThreshold ?? 1,
        unhealthyThreshold: props.unhealthyThreshold ?? 5,
      },
      observabilityConfiguration: {
        observabilityEnabled: true,
      },
    });

    this.serviceUrl = service.attrServiceUrl;
    this.serviceArn = service.attrServiceArn;
  }
}
