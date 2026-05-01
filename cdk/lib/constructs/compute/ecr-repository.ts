import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrRepositoryProps {
  /**
   * Maximum number of images to retain. Older images are deleted automatically.
   * @default 10
   */
  readonly maxImageCount?: number;
  /**
   * Removal policy for the repository.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * An ECR repository with basic image scanning enabled on every push.
 *
 * Shared by ECS and Lambda — both pull the same Docker image.
 */
export class EcrRepository extends Construct {
  /** The underlying CDK repository. */
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrRepositoryProps = {}) {
    super(scope, id);

    this.repository = new ecr.Repository(this, 'Repository', {
      imageScanOnPush: true,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: props.maxImageCount ?? 10,
          description: `Retain last ${props.maxImageCount ?? 10} images`,
        },
      ],
    });
  }
}
