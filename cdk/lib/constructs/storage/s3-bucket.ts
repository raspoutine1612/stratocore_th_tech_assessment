import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface S3BucketProps {
  /** KMS key used to encrypt all objects at rest. */
  readonly encryptionKey: kms.IKey;
  /**
   * Removal policy for the bucket.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
  /**
   * Required when removalPolicy is DESTROY — empties the bucket before deletion.
   * @default false
   */
  readonly autoDeleteObjects?: boolean;
  /**
   * Days before objects transition to S3 Glacier Instant Retrieval.
   * @default 90
   */
  readonly glacierTransitionDays?: number;
  /**
   * Days before objects are permanently deleted.
   * @default 365
   */
  readonly expirationDays?: number;
  /**
   * Days before incomplete multipart uploads are aborted.
   * @default 7
   */
  readonly abortIncompleteMultipartUploadDays?: number;
}

/**
 * An S3 bucket that is encrypted, private, and HTTPS-only by default.
 *
 * Public access is always blocked and SSL is always enforced — these are not configurable.
 */
export class S3Bucket extends Construct {
  /** The underlying CDK bucket. */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: S3BucketProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.encryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: props.autoDeleteObjects ?? false,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(props.glacierTransitionDays ?? 90),
            },
          ],
          expiration: cdk.Duration.days(props.expirationDays ?? 365),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(
            props.abortIncompleteMultipartUploadDays ?? 7,
          ),
        },
      ],
    });
  }

  /**
   * Grant exactly the actions needed by the file storage API:
   * s3:PutObject, s3:GetObject, s3:DeleteObject on objects, s3:ListBucket on the bucket.
   *
   * Also grants the necessary KMS permissions for the encryption key.
   */
  public grantFileAccess(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resourceArns: [`${this.bucket.bucketArn}/*`],
    });
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['s3:ListBucket'],
      resourceArns: [this.bucket.bucketArn],
    });
    this.bucket.encryptionKey?.grantEncryptDecrypt(grantee);
  }
}
