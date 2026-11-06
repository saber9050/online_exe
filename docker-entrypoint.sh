#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# 容器入口：保证 DATA_DIR 对 node 用户（uid 1000）可写，然后降权运行主进程。
#
# 为什么需要这个脚本：
#   业务进程应当以非 root（uid 1000 = 镜像内置的 node 用户）运行，但 -v 挂载进来的是
#   宿主机目录，属主由宿主机决定。只要宿主机忘了 chown 1000:1000，容器内 node 就写不了，
#   启动直接 EACCES: permission denied, mkdir '/data/releases'。
#   这类错误的责任在部署命令，不在代码，让使用者对着 EACCES 猜性价比太低，
#   所以由入口脚本兜底：以 root 进来 → 修属主 → 用 su-exec 降回 node 执行。
#
# 三种情况：
#   1. 属主本来就对          → 直接降权（不扫描目录，快路径）
#   2. 属主不对但能 chown    → chown -R 后降权
#   3. chown 也改不动（Windows 盘 / NFS / 只读）→ 降不了权就用 root 跑，并大声告警
# ─────────────────────────────────────────────────────────────────────────────
set -e

DATA_DIR="${DATA_DIR:-/data}"
RUN_UID=1000
RUN_GID=1000

# 已经以非 root 身份进入（docker run --user 1000）→ 没有权限修任何东西，直接执行
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# 目标目录不存在就先建出来（挂载点通常由 Docker 预建，但命名卷/自定义路径不一定）
mkdir -p "$DATA_DIR" 2>/dev/null || true

# 判断 uid 1000 能否写这个目录。
# 走 sh -c 而不是直接 su-exec test：test 是 shell 内建，未必在 PATH 里有独立可执行文件。
can_write_as_node() {
  su-exec "$RUN_UID:$RUN_GID" sh -c 'test -w "$1"' _ "$DATA_DIR" 2>/dev/null
}

# 快路径：node 能写就什么都不改，避免每次启动都递归 chown 一遍整个数据目录
if can_write_as_node; then
  exec su-exec "$RUN_UID:$RUN_GID" "$@"
fi

echo "[entrypoint] $DATA_DIR 对 uid=$RUN_UID 不可写，尝试修正属主"

# chown 失败不要 exit：挂载点在 Windows 盘（WSL /mnt/*）、NFS root_squash、
# 或者整个挂载是只读的时候，chown 本来就不可能成功，但服务未必不能跑。
if chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR" 2>/dev/null; then
  echo "[entrypoint] 属主已改为 $RUN_UID:$RUN_GID"
else
  echo "[entrypoint] chown 失败（挂载点可能是 Windows 盘 / NFS / 只读），跳过"
fi

# 修完再验一次，仍然写不了就退回 root —— 宁可带着告警跑起来，也别让容器起不来
if can_write_as_node; then
  exec su-exec "$RUN_UID:$RUN_GID" "$@"
fi

echo "[entrypoint] 警告：$DATA_DIR 对 uid=$RUN_UID 仍不可写，本次改用 root 运行"
echo "[entrypoint] 正式环境请修正宿主机目录属主后重建容器："
echo "[entrypoint]   sudo chown -R 1000:1000 <宿主机数据目录>"
echo "[entrypoint] 若该目录位于 Windows 盘（/mnt/c、/mnt/f 等），chown 永远不生效，"
echo "[entrypoint] 请把数据目录换到 WSL 的 ext4 文件系统（如 ~/online_exe-data），或改用命名卷。"
exec "$@"
