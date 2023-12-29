import { clusterFiles } from './config';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const TableName = 'RedisClusterTable';
const ddb = DynamoDBDocumentClient.from(new DynamoDB(clusterFiles.credentials));

export async function putOwnerNodeIP(ip: string, takeOverFrom = 'N/A') {
    console.log('saving owner node ip to db');
    await ddb.send(
        new PutCommand({
            TableName,
            Item: { pk: 'OWNER', val: ip },
            ConditionExpression: 'attribute_not_exists(pk) OR val = :t',
            ExpressionAttributeValues: { ':t': takeOverFrom },
        })
    );
}

export async function getOwnerNodeIP() {
    try {
        const result = await ddb.send(new GetCommand({ TableName, Key: { pk: 'OWNER' } }));
        return result.Item?.val as string;
    } catch (e) {
        return undefined;
    }
}
