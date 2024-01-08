#! /bin/bash

export REDIS_CLUSTER_FILES=/home/ubuntu/cluster-files

mkdir -p $REDIS_CLUSTER_FILES

read -r -d '' REDIS_CLUSTER_PRIVATE_KEY << EOM
{{PRIVATE_KEY}}
EOM

echo "$REDIS_CLUSTER_PRIVATE_KEY" > $REDIS_CLUSTER_FILES/key.pem
chmod 400 $REDIS_CLUSTER_FILES/key.pem

read -r -d '' REDIS_CLUSTER_PUBLIC_KEY << EOM
{{PUBLIC_KEY}}
EOM
echo "$REDIS_CLUSTER_PUBLIC_KEY" > $REDIS_CLUSTER_FILES/key.pub

read -r -d '' CREDENTIALS << EOM
{{CREDENTIALS}}
EOM
echo "$CREDENTIALS" > $REDIS_CLUSTER_FILES/credentials.json

echo "{{REDIS_PASSWORD}}" > $REDIS_CLUSTER_FILES/password
echo "{{CLUSTER_REPLICAS}}" > $REDIS_CLUSTER_FILES/replicas

chown -Rf ubuntu:ubuntu $REDIS_CLUSTER_FILES
chmod -Rf 755 $REDIS_CLUSTER_FILES

# * update apt
apt -y update

# * install redis
apt -y install redis-server redis-tools unzip git

# * listen all network interfaces
sed -i -e 's/bind 127.0.0.1 ::1/# bind 127.0.0.1 ::1/g' /etc/redis/redis.conf

# * disable protected mode, so that we can connect from outside
sed -i -e 's/protected-mode yes/protected-mode no/g' /etc/redis/redis.conf

# * enable appendonly
sed -i -e 's/appendonly no/appendonly yes/g' /etc/redis/redis.conf

# * set password
sed -i -e 's/# requirepass foobared/requirepass {{REDIS_PASSWORD}}/g' /etc/redis/redis.conf
sed -i -e 's/# masterauth <master-password>/masterauth {{REDIS_PASSWORD}}/g' /etc/redis/redis.conf

# * enable cluster
sed -i -e 's/# cluster-enabled yes/cluster-enabled yes/g' /etc/redis/redis.conf
IP=$(curl http://169.254.169.254/latest/meta-data/public-ipv4)
echo 'Public IP: $IP'
echo 'bind $IP' >> /etc/redis/redis.conf

service redis restart

runuser -l ubuntu -c 'curl -o- https://raw.githubusercontent.com/umuplus/redis-cluster/main/scripts/install.sh | bash'
