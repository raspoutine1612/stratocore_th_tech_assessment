import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface DynamoDbTableProps {
  /** KMS key used to encrypt the table at rest. */
  readonly encryptionKey: kms.IKey;
  /**
   * Removal policy for the table.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
  /**
   * Enable point-in-time recovery (35-day restore window).
   * @default true
   */
  readonly pointInTimeRecovery?: boolean;
}

/**
 * A DynamoDB table with customer-managed KMS encryption and on-demand billing.
 *
 * Schema is fixed: partition key = username (String).
 * This table is purpose-built for user authentication — the schema is not configurable.
 */
export class DynamoDbTable extends Construct {
  /** The underlying CDK table. */
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DynamoDbTableProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'username', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.encryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: props.pointInTimeRecovery ?? true,
      },
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
    });
  }

  /**
   * Grant dynamodb:GetItem on this table to the given principal.
   *
   * The API only reads user records for authentication — no writes, no scans.
   * Also grants the necessary KMS permissions for the encryption key.
   */
  public grantGetItem(grantee: iam.IGrantable): iam.Grant {
    return this.table.grant(grantee, 'dynamodb:GetItem');
  }

  /**
   * Grant full read/write access on this table to the given principal.
   *
   * Intended for demo/admin access — not for application roles.
   */
  public grantReadWrite(grantee: iam.IGrantable): void {
    this.table.grant(
      grantee,
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:DeleteItem',
      'dynamodb:Scan',
      'dynamodb:Query',
    );
    this.table.encryptionKey?.grantEncryptDecrypt(grantee);
  }
}
