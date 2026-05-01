import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface IamRoleProps {
  /** The AWS service principal that can assume this role (e.g. ecs-tasks, apprunner). */
  readonly assumedBy: iam.IPrincipal;
  /** Human-readable description of the role's purpose. */
  readonly description?: string;
  /**
   * AWS-managed or customer-managed policies to attach at creation time.
   * @default []
   */
  readonly managedPolicies?: iam.IManagedPolicy[];
}

/**
 * An IAM role with a hardened trust policy.
 *
 * Two statements are always written to the trust policy:
 *
 * 1. Allow — the intended service principal can assume this role (from props.assumedBy).
 *
 * 2. Deny — any principal whose aws:SourceAccount differs from the current account
 *    is blocked from assuming this role. This prevents confused-deputy attacks where
 *    an AWS service acting on behalf of a different account could assume our role.
 *
 *    aws:SourceAccount is the account that owns the resource triggering the service call
 *    (e.g. the account owning the ECS task or App Runner service). When the key is absent
 *    (direct IAM assume-role), StringNotEquals evaluates to false and the deny does not fire.
 */
export class IamRole extends Construct {
  /** The underlying CDK role. Pass to compute and pipeline constructs. */
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: IamRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, 'Role', {
      assumedBy: props.assumedBy,
      description: props.description,
      managedPolicies: props.managedPolicies ?? [],
    });

    // Deny any principal whose source account differs from this one.
    // StringNotEquals on a missing key returns false, so direct IAM principals
    // (where aws:SourceAccount is absent) are not affected by this deny.
    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['sts:AssumeRole'],
        conditions: {
          StringNotEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      }),
    );
  }
}
