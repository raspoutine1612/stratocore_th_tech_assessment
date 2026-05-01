import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AppRunner } from '../constructs/compute/app-runner';
import { LogGroup } from '../constructs/observability/log-group';
import { IamRole } from '../constructs/security/iam-role';
import { KmsKey } from '../constructs/security/kms-key';

export interface AppRunnerApiProps {
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
 * The App Runner compute target for stratocore.
 *
 * Creates: KMS key + LogGroup, instance role, AppRunner service.
 * Applies scoped IAM grants for S3 and DynamoDB internally.
 */
export class AppRunnerApi extends Construct {
  public readonly serviceUrl: string;
  /** The App Runner service ARN. Needed to trigger deployments from the pipeline. */
  public readonly serviceArn: string;

  constructor(scope: Construct, id: string, props: AppRunnerApiProps) {
    super(scope, id);

    const logKey = new KmsKey(this, 'LogKey', {
      description: 'Encrypts App Runner container logs in CloudWatch',
      removalPolicy: props.removalPolicy,
    });

    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: '/file-api/app-runner',
      // LogGroup expects KmsKey (our construct), not kms.Key.
      encryptionKey: logKey,
      removalPolicy: props.removalPolicy,
    });

    const instanceRole = new IamRole(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description: 'Allows the stratocore App Runner container to access S3 and DynamoDB',
    });

    // fromBucketAttributes returns IBucket which has no grant() method.
    // iam.Grant.addToPrincipal lets us specify exact actions without wildcards.
    const bucketKey = kms.Key.fromKeyArn(this, 'BucketKey', props.bucketKmsKeyArn);
    const bucket = s3.Bucket.fromBucketAttributes(this, 'Bucket', {
      bucketArn: props.bucketArn,
      encryptionKey: bucketKey,
    });

    iam.Grant.addToPrincipal({
      grantee: instanceRole.role,
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resourceArns: [`${props.bucketArn}/*`],
    });
    iam.Grant.addToPrincipal({
      grantee: instanceRole.role,
      actions: ['s3:ListBucket'],
      resourceArns: [props.bucketArn],
    });
    bucketKey.grantEncryptDecrypt(instanceRole.role);

    // ITable has grant() — no cast needed.
    const tableKey = kms.Key.fromKeyArn(this, 'TableKey', props.tableKmsKeyArn);
    const table = dynamodb.Table.fromTableAttributes(this, 'Table', {
      tableArn: props.tableArn,
      encryptionKey: tableKey,
    });
    table.grant(instanceRole.role, 'dynamodb:GetItem');
    tableKey.grantDecrypt(instanceRole.role);

    const runner = new AppRunner(this, 'Service', {
      imageUri: props.imageUri,
      logGroup: logGroup.logGroup,
      instanceRole: instanceRole.role,
      environment: {
        AWS_REGION: props.awsRegion,
        S3_BUCKET_NAME: props.bucketName,
        DYNAMO_TABLE_NAME: props.tableName,
      },
    });

    this.serviceUrl = runner.serviceUrl;
    this.serviceArn = runner.serviceArn;
  }
}
