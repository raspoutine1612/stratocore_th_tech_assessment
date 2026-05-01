import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DynamoDbTable } from '../constructs/storage/dynamodb-table';
import { S3Bucket } from '../constructs/storage/s3-bucket';
import { KmsKey } from '../constructs/security/kms-key';

export interface FileStorageProps {
  /**
   * Removal policy applied to the S3 bucket, DynamoDB table, and their KMS keys.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
  /**
   * Required when removalPolicy is DESTROY — empties the bucket before deletion.
   * @default false
   */
  readonly autoDeleteObjects?: boolean;
}

/**
 * The persistent storage layer for stratocore.
 *
 * Creates and owns:
 * - An S3 bucket for file objects (KMS-encrypted).
 * - A DynamoDB table for user records (KMS-encrypted).
 * - Separate KMS keys for each resource.
 *
 * KMS key ARNs are exposed so SharedStack can publish them to SSM.
 * Compute stacks import those ARNs to apply precise grants on the resources.
 */
export class FileStorage extends Construct {
  /** S3 bucket construct. */
  public readonly bucket: S3Bucket;
  /** KMS key protecting the S3 bucket. Publish its ARN to SSM for cross-stack grants. */
  public readonly bucketKey: KmsKey;
  /** DynamoDB users table construct. */
  public readonly table: DynamoDbTable;
  /** KMS key protecting the DynamoDB table. Publish its ARN to SSM for cross-stack grants. */
  public readonly tableKey: KmsKey;

  constructor(scope: Construct, id: string, props: FileStorageProps = {}) {
    super(scope, id);

    this.bucketKey = new KmsKey(this, 'BucketKey', {
      description: 'Encrypts stratocore S3 file storage',
      removalPolicy: props.removalPolicy,
    });

    this.tableKey = new KmsKey(this, 'TableKey', {
      description: 'Encrypts stratocore DynamoDB users table',
      removalPolicy: props.removalPolicy,
    });

    this.bucket = new S3Bucket(this, 'Bucket', {
      encryptionKey: this.bucketKey.key,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
    });

    this.table = new DynamoDbTable(this, 'Table', {
      encryptionKey: this.tableKey.key,
      removalPolicy: props.removalPolicy,
    });
  }

  /**
   * Grant full S3 + DynamoDB + KMS access to the given principal.
   *
   * Use this for demo/admin accounts only — not for application roles.
   */
  public grantAdminAccess(grantee: iam.IGrantable): void {
    this.bucket.grantFileAccess(grantee);
    this.bucketKey.key.grantEncryptDecrypt(grantee);
    this.table.grantReadWrite(grantee);
    this.tableKey.key.grantEncryptDecrypt(grantee);
  }
}
