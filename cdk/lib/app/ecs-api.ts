import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EcsFargate } from '../constructs/compute/ecs-fargate';
import { LogGroup } from '../constructs/observability/log-group';
import { IamRole } from '../constructs/security/iam-role';
import { KmsKey } from '../constructs/security/kms-key';
import { grantStorageAccess } from './storage-grants';

export interface EcsApiProps {
  readonly vpc: ec2.IVpc;
  readonly httpListener: elbv2.IApplicationListener;
  readonly albSecurityGroup: ec2.ISecurityGroup;
  readonly imageUri: string;
  readonly bucketName: string;
  readonly bucketArn: string;
  readonly bucketKmsKeyArn: string;
  readonly tableName: string;
  readonly tableArn: string;
  readonly tableKmsKeyArn: string;
  readonly awsRegion: string;
  /** @default RemovalPolicy.RETAIN */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * The ECS Fargate compute target for stratocore.
 *
 * Creates: KMS key + LogGroup, task role + execution role, EcsFargate service.
 * Applies scoped IAM grants for S3 and DynamoDB internally.
 */
export class EcsApi extends Construct {
  public readonly fargate: EcsFargate;

  constructor(scope: Construct, id: string, props: EcsApiProps) {
    super(scope, id);

    const logKey = new KmsKey(this, 'LogKey', {
      description: 'Encrypts ECS container logs in CloudWatch',
      removalPolicy: props.removalPolicy,
    });

    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: '/file-api/ecs/app',
      // LogGroup expects KmsKey (our construct), not kms.Key.
      encryptionKey: logKey,
      removalPolicy: props.removalPolicy,
    });

    const taskRole = new IamRole(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Allows the stratocore ECS container to access S3 and DynamoDB',
    });

    const executionRole = new IamRole(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Allows ECS agent to pull image from ECR and write to CloudWatch Logs',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // SSM tokens prevent using grant() on imported resources — grantStorageAccess handles both targets.
    grantStorageAccess(this, 'StorageGrants', taskRole.role, {
      bucketArn: props.bucketArn,
      bucketKmsKeyArn: props.bucketKmsKeyArn,
      tableArn: props.tableArn,
      tableKmsKeyArn: props.tableKmsKeyArn,
    });

    this.fargate = new EcsFargate(this, 'Fargate', {
      vpc: props.vpc,
      httpListener: props.httpListener,
      imageUri: props.imageUri,
      logGroup: logGroup.logGroup,
      taskRole: taskRole.role,
      executionRole: executionRole.role,
      environment: {
        AWS_REGION: props.awsRegion,
        S3_BUCKET_NAME: props.bucketName,
        DYNAMO_TABLE_NAME: props.tableName,
      },
    });

    this.fargate.allowInboundFrom(props.albSecurityGroup);
  }
}
