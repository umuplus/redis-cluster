#! /bin/bash

export REDIS_CLUSTER_FILES=/home/ubuntu/cluster-files

mkdir -p $REDIS_CLUSTER_FILES

read -r -d '' REDIS_CLUSTER_PRIVATE_KEY << EOM
{{PRIVATE_KEY}}
EOM

echo "$REDIS_CLUSTER_PRIVATE_KEY" > $REDIS_CLUSTER_FILES/key.pem

read -r -d '' REDIS_CLUSTER_PUBLIC_KEY << EOM
{{PUBLIC_KEY}}
EOM
echo "$REDIS_CLUSTER_PUBLIC_KEY" > $REDIS_CLUSTER_FILES/key.pub

read -r -d '' CREDENTIALS << EOM
{{CREDENTIALS}}
EOM
echo "$CREDENTIALS" > $REDIS_CLUSTER_FILES/credentials.json

echo "{{CLUSTER_REPLICAS}}" > $REDIS_CLUSTER_FILES/replicas
echo "{{NLB_ARN}}" > $REDIS_CLUSTER_FILES/nlb
echo "{{REDIS_PASSWORD}}" > $REDIS_CLUSTER_FILES/password
echo "{{ADMIN_API_KEY}}" > $REDIS_CLUSTER_FILES/adminApiKey
echo "{{TARGET_GROUP_ARN}}" > $REDIS_CLUSTER_FILES/target-group

chown -Rf ubuntu:ubuntu $REDIS_CLUSTER_FILES
chmod -Rf 755 $REDIS_CLUSTER_FILES
chmod 400 $REDIS_CLUSTER_FILES/key.*

read -r -d '' MAX_FILES_LIMIT << EOM
* soft     nproc          65535
* hard     nproc          65535
* soft     nofile         65535
* hard     nofile         65535
root soft     nproc          65535
root hard     nproc          65535
root soft     nofile         65535
root hard     nofile         65535
EOM
echo "$MAX_FILES_LIMIT" >> /etc/security/limits.conf
echo 'session required pam_limits.so' >> /etc/pam.d/common-session
echo 'fs.file-max = 65535' >> /etc/sysctl.conf
sudo sysctl -p

# * update apt
apt -y update

# * install redis
apt -y install redis-server redis-tools unzip git

# * listen all network interfaces
sed -i -e 's/bind 127.0.0.1 ::1/# bind 127.0.0.1 ::1/g' /etc/redis/redis.conf

# * disable protected mode, so that we can connect from outside
sed -i -e 's/protected-mode yes/protected-mode no/g' /etc/redis/redis.conf

# * disable persistence
sed -i -e 's/save 900 1/# save 900 1/g' /etc/redis/redis.conf
sed -i -e 's/save 300 10/# save 300 10/g' /etc/redis/redis.conf
sed -i -e 's/save 60 10000/# save 60 10000/g' /etc/redis/redis.conf
sed -i -e 's/#   save ""/save ""/g' /etc/redis/redis.conf

# * set password
sed -i -e 's/# requirepass foobared/requirepass {{REDIS_PASSWORD}}/g' /etc/redis/redis.conf
sed -i -e 's/# masterauth <master-password>/masterauth {{REDIS_PASSWORD}}/g' /etc/redis/redis.conf

# * enable cluster
sed -i -e 's/# cluster-enabled yes/cluster-enabled yes/g' /etc/redis/redis.conf
export MY_PUBLIC_IP=$(curl http://169.254.169.254/latest/meta-data/public-ipv4)
echo "Public IP: $MY_PUBLIC_IP"
echo "cluster-announce-ip $MY_PUBLIC_IP" >> /etc/redis/redis.conf
echo 'bind 0.0.0.0' >> /etc/redis/redis.conf

service redis restart

runuser -l ubuntu -c 'curl -o- https://raw.githubusercontent.com/umuplus/redis-cluster/main/scripts/install.sh | bash'
