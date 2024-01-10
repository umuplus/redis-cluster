import { Cluster, Redis } from 'ioredis';

const connections: Array<Cluster | Redis> = [];
const writes: number[] = [];
const reads: number[] = [];
const errors: string[] = [];

async function main() {
    try {
        const [_cmd, _file, server, port, password, ops, conn, noCluster] = process.argv;
        const numberOfConcurrentConnections = parseInt(conn || '10');
        const numberOfConcurrentOperationsPerConnection = parseInt(ops || '10');
        const isCluster = noCluster !== 'no-cluster';

        const attackPromises: Promise<void>[] = [];
        for (let i = 0; i < numberOfConcurrentConnections; i++)
            attackPromises.push(
                attack(
                    isCluster,
                    server,
                    parseInt(port || '6379'),
                    password,
                    numberOfConcurrentConnections,
                    numberOfConcurrentOperationsPerConnection
                )
            );
        await Promise.all(attackPromises);

        for (const e of errors) console.error(e);
        console.log(
            'avg',
            Math.ceil(writes.reduce((a, b) => a + b, 0) / writes.length) + 'ms',
            'for',
            writes.length,
            'writes from',
            numberOfConcurrentConnections,
            'connections'
        );
        console.log(
            'avg',
            Math.ceil(reads.reduce((a, b) => a + b, 0) / reads.length) + 'ms',
            'for',
            reads.length,
            'reads from',
            numberOfConcurrentConnections,
            'connections'
        );
    } catch (e) {
        console.error((e as Error).message);
    }
    for (const connection of connections) connection.disconnect();
}

async function attack(
    isCluster: boolean,
    server: string,
    port: number,
    password: string,
    conn: number,
    ops: number
) {
    let connection: Cluster | Redis;
    if (isCluster) {
        connection = new Cluster(
            [
                {
                    host: server,
                    port: 6379,
                },
            ],
            {
                scaleReads: 'slave',
                slotsRefreshTimeout: 30000,
                redisOptions: { password },
            }
        );
    } else {
        connection = new Redis(port, server, { password });
    }
    const id = connections.push(connection);
    console.log('connection', id, 'created on', server);
    const promises: Promise<any>[] = [];
    for (let i = 0; i < ops; i++) {
        const key = generateString();
        const value = generateString();
        let now = Date.now();
        const start = Date.now();
        promises.push(
            connection.set(key, value, 'EX', 60).then(() => {
                writes.push(Date.now() - now);
                now = Date.now();
                return connection.get(key).then((r) => {
                    if (r === value) reads.push(Date.now() - now);
                    else errors.push(`${id * conn + i} failed in ${Date.now() - start}ms`);
                });
            })
        );
    }
    await Promise.all(promises);
}

function generateString() {
    return Math.random().toString(36).slice(2);
}

main();
