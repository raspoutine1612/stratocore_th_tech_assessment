import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VpcProps {
  /**
   * Number of Availability Zones to use.
   * @default 2
   */
  readonly maxAzs?: number;
  /**
   * Number of NAT Gateways. Set to 0 to reduce cost in non-production environments.
   * @default 1
   */
  readonly natGateways?: number;
  /**
   * CIDR mask for public subnets.
   * @default 24
   */
  readonly publicSubnetCidrMask?: number;
  /**
   * CIDR mask for private subnets.
   * @default 24
   */
  readonly privateSubnetCidrMask?: number;
}

/**
 * A VPC with public and private subnets across multiple Availability Zones.
 *
 * Public subnets host the ALB. Private subnets host ECS tasks.
 * Traffic from private subnets to the internet routes through a NAT Gateway.
 *
 * S3 and DynamoDB Gateway Endpoints are added so ECS containers reach those
 * services directly over the AWS network — no NAT Gateway cost or internet hop.
 */
export class Vpc extends Construct {
  /** The underlying CDK VPC. Pass to network and compute constructs. */
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: VpcProps = {}) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: props.maxAzs ?? 2,
      natGateways: props.natGateways ?? 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: props.publicSubnetCidrMask ?? 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: props.privateSubnetCidrMask ?? 24,
        },
      ],
      // Gateway Endpoints are free and route S3/DynamoDB traffic
      // through the AWS network instead of the NAT Gateway.
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
        DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB },
      },
    });
  }
}
