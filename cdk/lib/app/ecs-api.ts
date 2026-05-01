import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EcsFargate } from '../constructs/compute/ecs-fargate';
import { LogGroup } from '../constructs/observability/log-group';
import { IamRole } from '../constructs/security/iam-role';
import { KmsKey } from '../constructs/security/kms-key';

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

    // fromBucketAttributes returns IBucket which has no grant() method.
    // iam.Grant.addToPrincipal lets us specify exact actions without wildcards.
    const bucketKey = kms.Key.fromKeyArn(this, 'BucketKey', props.bucketKmsKeyArn);
    const bucket = s3.Bucket.fromBucketAttributes(this, 'Bucket', {
      bucketArn: props.bucketArn,
      encryptionKey: bucketKey,
    });

    iam.Grant.addToPrincipal({
      grantee: taskRole.role,
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resourceArns: [`${props.bucketArn}/*`],
    });
    iam.Grant.addToPrincipal({
      grantee: taskRole.role,
      actions: ['s3:ListBucket'],
      resourceArns: [props.bucketArn],
    });
    bucketKey.grantEncryptDecrypt(taskRole.role);

    // ITable has grant() — no cast needed.
    const tableKey = kms.Key.fromKeyArn(this, 'TableKey', props.tableKmsKeyArn);
    const table = dynamodb.Table.fromTableAttributes(this, 'Table', {
      tableArn: props.tableArn,
      encryptionKey: tableKey,
    });
    table.grant(taskRole.role, 'dynamodb:GetItem');
    tableKey.grantDecrypt(taskRole.role);

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
