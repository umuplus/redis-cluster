#!/usr/bin/env node

import { DynamoDB } from '@aws-sdk/client-dynamodb';
import {
    BatchWriteCommand,
    DynamoDBDocumentClient,
    PutCommand,
    ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { execSync } from 'child_process';
import { parse } from 'ini';
import { join as joinPath } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { readFileSync } from 'fs';
import { prompt } from 'inquirer';

// @ts-ignore
import chalk = require('chalk');

const TableName = 'RedisClusterTable';
let ddb: DynamoDBDocumentClient | undefined;

async function deploy() {
    try {
        const profiles = getAwsConfiguration();

        const profileNames = Object.keys(profiles)
            .filter((key) => key !== 'default')
            .sort((a, b) => (a.toLowerCase() > b.toLowerCase() ? 1 : -1));
        profileNames.unshift('default');
        const cloudProfile = await prompt([
            {
                type: 'list',
                name: 'val',
                message: 'Which AWS profile do you want to use?',
                choices: profileNames,
            },
        ]);

        const profile = cloudProfile.val;
        console.log('deploying to', profile);

        console.log('installing all dependencies...');
        execSync('npm run clean', { stdio: 'inherit' });

        console.log('compiling...');
        execSync('npm run build', { stdio: 'inherit' });

        const pathTmp = joinPath(__dirname, 'tmp');
        const pathNodeJs = joinPath(pathTmp, 'nodejs');
        mkdirSync(pathNodeJs, { recursive: true });
        execSync(`cp package*.json ${pathNodeJs}/.`, { stdio: 'inherit' });

        console.log('installing production dependencies only...');
        execSync('npm install --production --silent', { cwd: pathNodeJs, stdio: 'inherit' });

        console.log('packaging production dependencies...');
        execSync('zip -q -r node_modules.zip nodejs', { cwd: pathTmp, stdio: 'inherit' });

        if (!ddb) ddb = DynamoDBDocumentClient.from(new DynamoDB(profiles[profile]));

        const config = await getConfigurationFromDB();

        const hasKeys = !!(config.PUBLIC_KEY && config.PRIVATE_KEY);
        if (!hasKeys) {
            execSync('ssh-keygen -t ed25519 -f ./redis-cluster -q -N ""', {
                cwd: pathTmp,
                stdio: 'inherit',
            });
            config.PRIVATE_KEY = { val: readFileSync(joinPath(pathTmp, 'redis-cluster'), 'utf-8') };
            config.PUBLIC_KEY = {
                val: readFileSync(joinPath(pathTmp, 'redis-cluster.pub'), 'utf-8'),
            };
        } else {
            writeFileSync(joinPath(pathTmp, 'redis-cluster'), config.PRIVATE_KEY.val);
            writeFileSync(joinPath(pathTmp, 'redis-cluster.pub'), config.PUBLIC_KEY.val);
        }

        let password = config.REDIS_PASSWORD?.val.trim();
        const hasPassword = !!password;
        if (!hasPassword) password = generatePassword();
        writeFileSync(joinPath(pathTmp, 'password'), password);
        writeFileSync(joinPath(pathTmp, 'credentials'), JSON.stringify(profiles[profile]));

        let adminApiKey = config.ADMIN_API_KEY?.val.trim();
        const hasAdminApiKey = !!adminApiKey;
        if (!hasAdminApiKey) adminApiKey = generatePassword();
        writeFileSync(joinPath(pathTmp, 'adminApiKey'), adminApiKey);

        execSync(`npm run cdk -- synth -q --profile ${profile}`, { stdio: 'inherit' });

        // execSync(`npm run cdk -- bootstrap -q --profile ${profile}`, { stdio: 'inherit' });

        execSync(
            `npm run cdk -- deploy --require-approval never RedisClusterStack --profile ${profile}`,
            {
                stdio: 'inherit',
            }
        );

        if (!hasKeys) await putSshKeysToDB(config.PRIVATE_KEY.val, config.PUBLIC_KEY.val);
        if (!hasPassword) await putRedisPassword(password);
        if (!hasAdminApiKey) await putAdminApiKey(adminApiKey);

        console.log('cleaning up...');
        execSync('npm run clean', { stdio: 'inherit' });
        console.log('done!');
    } catch (e) {
        console.error(chalk.red.italic((e as Error).message));
        console.log((e as Error).stack);
        console.log('cleaning up...');
        execSync('npm run clean', { stdio: 'inherit' });
        console.log('done!');
    }
}

const pathAwsConfiguration = `${process.env.HOME}/.aws/config`;
const pathAwsCredentials = `${process.env.HOME}/.aws/credentials`;

type Credentials = {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
};
function getAwsConfiguration() {
    try {
        const awsConfiguration = parse(readFileSync(pathAwsConfiguration).toString());
        const awsCredentials = parse(readFileSync(pathAwsCredentials).toString());

        return Object.keys(awsConfiguration).reduce((final: Record<string, Credentials>, key) => {
            const target = key.startsWith('profile ') ? key.slice(8) : key;
            if (awsCredentials[target]) {
                final[target] = {
                    region: awsConfiguration[key].region,
                    credentials: {
                        accessKeyId: awsCredentials[target].aws_access_key_id,
                        secretAccessKey: awsCredentials[target].aws_secret_access_key,
                    },
                };
            }
            return final;
        }, {});
    } catch (e) {
        console.log(e);
        throw new Error(`AWS is not configured`);
    }
}

async function getConfigurationFromDB(): Promise<Record<string, any>> {
    try {
        const result = await ddb!.send(new ScanCommand({ TableName }));
        return (
            result.Items?.reduce((final: Record<string, any>, item) => {
                final[item.pk] = item;
                return final;
            }, {}) || {}
        );
    } catch (e) {
        return {};
    }
}

async function putRedisPassword(password: string) {
    try {
        console.log('saving redis password to db');
        await ddb!.send(
            new PutCommand({
                TableName,
                Item: { pk: 'REDIS_PASSWORD', val: password },
            })
        );
    } catch (e) {
        console.log('redis password not saved to db');
    }
}

async function putAdminApiKey(apiKey: string) {
    try {
        console.log('saving admin api key to db');
        await ddb!.send(
            new PutCommand({
                TableName,
                Item: { pk: 'ADMIN_API_KEY', val: apiKey },
            })
        );
    } catch (e) {
        console.log('admin api key not saved to db');
    }
}

async function putSshKeysToDB(privateKey: string, publicKey: string) {
    try {
        console.log('saving ssh keys to db');
        await ddb!.send(
            new BatchWriteCommand({
                RequestItems: {
                    [TableName]: [
                        { PutRequest: { Item: { pk: 'PUBLIC_KEY', val: publicKey } } },
                        { PutRequest: { Item: { pk: 'PRIVATE_KEY', val: privateKey } } },
                    ],
                },
            })
        );
    } catch (e) {
        console.log('ssh keys not saved to db');
    }
}

function generatePassword() {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

deploy();
