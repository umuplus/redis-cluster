import { clusterFiles } from './config';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const TableName = 'RedisClusterTable';
const ddb = DynamoDBDocumentClient.from(new DynamoDB(clusterFiles.credentials));

export async function putMasterNodeIP(ip: string, takeOverFrom = 'N/A') {
    try {
        console.log('saving master node ip to db');
        await ddb.send(
            new PutCommand({
                TableName,
                Item: { pk: 'MASTER', val: ip },
                ConditionExpression: 'attribute_not_exists(pk) OR val = :t',
                ExpressionAttributeValues: { ':t': takeOverFrom },
            })
        );
    } catch (e) {
        console.log('master node ip not saved to db');
    }
}

export async function getMasterNodeIP() {
    try {
        const result = await ddb.send(new GetCommand({ TableName, Key: { pk: 'MASTER' } }));
        return result.Item?.val as string;
    } catch (e) {
        return undefined;
    }
}
