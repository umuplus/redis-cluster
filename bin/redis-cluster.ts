#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { RedisClusterStack } from '../stacks/redis-cluster-stack';

const app = new App();
new RedisClusterStack(app, 'RedisClusterStack', {
    terminationProtection: false,
});
