import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
    CfnKeyPair,
    GenericLinuxImage,
    InstanceType,
    IpAddresses,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    UserData,
    Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { join as joinPath } from 'path';
import { NetworkLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { readFileSync } from 'fs';
import { RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';

const AWS_EC2_AMI_UBUNTU_2204LTS: Record<string, string> = {
    'af-south-1': 'ami-0ccedbebe3a0f5ecc',
    'ap-east-1': 'ami-0dfd8979d410239bd',
    'ap-northeast-1': 'ami-01044a7484292fef7',
    'ap-northeast-2': 'ami-0bf8362da831d2394',
    'ap-northeast-3': 'ami-0ef3899bdec163193',
    'ap-south-1': 'ami-077885f59ecb77b84',
    'ap-south-2': 'ami-01b5aa258adc56a81',
    'ap-southeast-1': 'ami-05f8c2ee58e71f8e6',
    'ap-southeast-2': 'ami-0b71cd1a5da0c93ec',
    'ap-southeast-3': 'ami-0eef232885701f631',
    'ap-southeast-4': 'ami-02190f00eb144037e',
    'ca-central-1': 'ami-0a51bed764c1749b6',
    'ca-west-1': 'ami-05f4010bf08fa598b',
    'cn-north-1': 'ami-070944db486cc107f',
    'cn-northwest-1': 'ami-0baca953ae7299a69',
    'eu-central-1': 'ami-0fc02b454efabb390',
    'eu-central-2': 'ami-0f5e7ad1a5de42912',
    'eu-north-1': 'ami-0c3d6a10a198d282d',
    'eu-south-1': 'ami-01671c02f287044a6',
    'eu-south-2': 'ami-07c505a78dad4d474',
    'eu-west-1': 'ami-0a1b36900d715a3ad',
    'eu-west-2': 'ami-00efc25778562c229',
    'eu-west-3': 'ami-0ac1b923393d5082a',
    'il-central-1': 'ami-0c5069d89e521043f',
    'me-central-1': 'ami-0467fef53b9b387e4',
    'me-south-1': 'ami-0a45bc9705f19693b',
    'sa-east-1': 'ami-063c7dd3218e07c07',
    'us-east-1': 'ami-05d47d29a4c2d19e1',
    'us-east-2': 'ami-0748d13ffbc370c2b',
    'us-west-1': 'ami-07f8b4231133414a6',
    'us-west-2': 'ami-0a24e6e101933d294',
};

export class RedisClusterStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        const rootFolder = joinPath(__dirname, '..');
        const packageJson = JSON.parse(readFileSync(`${rootFolder}/package.json`, 'utf-8'));
        const publicKey = readFileSync(`${rootFolder}/tmp/redis-cluster.pub`, 'utf-8');
        const privateKey = readFileSync(`${rootFolder}/tmp/redis-cluster`, 'utf-8');
        const password = readFileSync(`${rootFolder}/tmp/password`, 'utf-8');
        const credentials = readFileSync(`${rootFolder}/tmp/credentials`, 'utf-8');

        const { cluster } = packageJson;
        const numberOfNodes = cluster.cache.master * (cluster.cache.replicas + 1);

        console.log(numberOfNodes, 'cache nodes will be created as', cluster.cache.type);
        console.log(cluster.proxy.count, 'proxy nodes will be created as', cluster.proxy.type);

        const vpc = new Vpc(this, 'ClusterVpc', {
            ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
            natGateways: 1,
            maxAzs: 3,
            subnetConfiguration: [
                {
                    name: 'private-subnet-1',
                    subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                    cidrMask: 24,
                },
                {
                    name: 'public-subnet-1',
                    subnetType: SubnetType.PUBLIC,
                    cidrMask: 24,
                },
                {
                    name: 'isolated-subnet-1',
                    subnetType: SubnetType.PRIVATE_ISOLATED,
                    cidrMask: 28,
                },
            ],
        });

        new Table(this, 'OrchestrationTable', {
            tableName: 'RedisClusterTable',
            partitionKey: { name: 'pk', type: AttributeType.STRING },
            billingMode: BillingMode.PAY_PER_REQUEST,
            removalPolicy: RemovalPolicy.DESTROY,
            timeToLiveAttribute: 'exp',
        });

        const keyPair = new CfnKeyPair(this, 'KeyPair', {
            keyName: 'RedisClusterKey',
            publicKeyMaterial: publicKey,
            keyType: 'ed25519',
        });

        const securityGroup = new SecurityGroup(this, 'SecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });
        securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22));
        securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(6379));
        securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(16379));

        const commonInitPath = joinPath(rootFolder, 'scripts', 'common-init.sh');
        const commonInitSourceCode = readFileSync(commonInitPath, 'utf-8');
        const cacheInitPath = joinPath(rootFolder, 'scripts', 'cache-init.sh');
        const cacheInitSourceCode = readFileSync(cacheInitPath, 'utf-8')
            .replace('{{COMMON}}', commonInitSourceCode)
            .replace('{{NODE_TYPE}}', 'cache')
            .replace(/{{REDIS_PASSWORD}}/g, password)
            .replace('{{PRIVATE_KEY}}', privateKey)
            .replace('{{PUBLIC_KEY}}', publicKey)
            .replace('{{CREDENTIALS}}', credentials)
            .replace('{{CLUSTER_REPLICAS}}', cluster.cache.replicas.toString());
        new AutoScalingGroup(this, 'CacheASG', {
            vpc,
            autoScalingGroupName: 'RedisClusterCacheASG',
            vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
            instanceType: new InstanceType(cluster.cache.type),
            machineImage: new GenericLinuxImage(AWS_EC2_AMI_UBUNTU_2204LTS),
            userData: UserData.custom(cacheInitSourceCode),
            minCapacity: 0,
            maxCapacity: 0,
            securityGroup: securityGroup,
            keyName: keyPair.keyName,
        });

        const proxyInitPath = joinPath(rootFolder, 'scripts', 'proxy-init.sh');
        const proxyInitSourceCode = readFileSync(proxyInitPath, 'utf-8')
            .replace('{{COMMON}}', commonInitSourceCode)
            .replace('{{NODE_TYPE}}', 'proxy')
            .replace(/{{REDIS_PASSWORD}}/g, password)
            .replace('{{PRIVATE_KEY}}', privateKey)
            .replace('{{PUBLIC_KEY}}', publicKey)
            .replace('{{CREDENTIALS}}', credentials)
            .replace('{{CLUSTER_REPLICAS}}', cluster.cache.replicas.toString());
        const proxyASG = new AutoScalingGroup(this, 'ProxyASG', {
            vpc,
            autoScalingGroupName: 'RedisClusterProxyASG',
            vpcSubnets: { subnetType: SubnetType.PUBLIC },
            instanceType: new InstanceType(cluster.proxy.type),
            machineImage: new GenericLinuxImage(AWS_EC2_AMI_UBUNTU_2204LTS),
            userData: UserData.custom(proxyInitSourceCode),
            minCapacity: 0,
            maxCapacity: 0,
            securityGroup: securityGroup,
            keyName: keyPair.keyName,
        });

        // * add an NLB to provide a single endpoint for the cluster
        const nlb = new NetworkLoadBalancer(this, 'NLB', { vpc });
        const listener = nlb.addListener('Listener', { port: 6379 });
        listener.addTargets('RedisClusterProxyTarget', { port: 6379, targets: [proxyASG] });

        Tags.of(this).add('costcenter', 'redis_cluster');
    }
}
