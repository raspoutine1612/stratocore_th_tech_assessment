import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface AlbProps {
  /** VPC in which to place the ALB (public subnets). */
  readonly vpc: ec2.IVpc;
}

/**
 * An internet-facing Application Load Balancer serving HTTP traffic.
 *
 * The default action on the HTTP listener returns 404 — attach target groups to add routes.
 * Security is enforced via Security Groups: only the ALB can reach ECS tasks.
 *
 * Note: HTTPS can be added by providing an ACM certificate and a Route 53 hosted zone.
 * For this demo, HTTP is used to avoid the domain registration requirement.
 */
export class Alb extends Construct {
  /** The underlying CDK load balancer. */
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  /** The HTTP listener. Attach ECS target groups to it from the EcsStack. */
  public readonly httpListener: elbv2.ApplicationListener;
  /** Security group controlling inbound access to the ALB. */
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: AlbProps) {
    super(scope, id);

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'ALB - allows inbound HTTP from the internet',
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet',
    );

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.securityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    this.httpListener = this.loadBalancer.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'No target',
      }),
    });
  }
}
