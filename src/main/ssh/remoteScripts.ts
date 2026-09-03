import { shellQuote } from '../../shared/sftpPath'

/**
 * 远程执行的脚本/命令集中维护（在目标主机 shell 里跑，注意 POSIX 可移植性）：
 * - 性能采集：自包含 sh，只依赖 /proc + df -P，输出归一化单行（perf.ts 解析）
 * - 目录删除：rm -rf，路径必须经 shellQuote 转义
 */

/** 性能采集脚本：
 *  输出归一化多行（perf.ts 按行首前缀解析）：
 *  "P <cpuTotal1> <cpuIdle1> <cpuTotal2> <cpuIdle2> <memTotalKb> <memAvailKb> <dfBlocks> <dfUsed> <cores> <swapTotalKb> <swapUsedKb> <netRxBytes> <netTxBytes> <load1> <load5> <load15> <procsRun> <procsTotal> <uptimeSec>"
 *  "M <memFreeKb> <buffersKb> <cachedKb> <sReclaimableKb>"（内存细分：空闲/缓存）
 *  "C <n> <total0> <idle0> <total1> <idle1> …"（每逻辑核原始 jiffies，跨轮差值算占用）
 *  "T <timezone>"（/etc/timezone → /etc/localtime → date +%Z）
 *  "L <lsblk -P 行>"（NAME/TYPE/PKNAME/SIZE/MOUNTPOINT，物理盘→分区树）
 *  "F <device> <fstype> <blocksKb> <usedKb> <availKb> <mount>"（df -PTk 挂载点）
 *  "R <name> <readSectors> <writeSectors>"（/proc/diskstats 物理盘原始扇区，跨轮差值算读写速度）
 *  "O <OS prettyName>"
 *  CPU 总使用率用脚本内 sleep 1 双读 /proc/stat 的 1s 窗口（首轮即有值）；
 *  每核/磁盘读写速度与网络速率一致，用跨轮差值（首轮为空） */
export const PERF_SCRIPT = `u=0 n=0 s=0 idle=0 iow=0 irq=0 sirq=0 st=0 cores=0 mt=0 ma=0 mf=0 bf=0 ca=0 sr=0 db=0 du=0 spt=0 spu=0 rx=0 tx=0 l1=0 l5=0 l15=0 pr=0 pt=0 up=0
read -r _ u n s idle iow irq sirq st _ < /proc/stat
t1=$((u+n+s+idle+iow+irq+sirq+st))
i1=$((idle+iow))
sleep 1
read -r _ u n s idle iow irq sirq st _ < /proc/stat
total=$((u+n+s+idle+iow+irq+sirq+st))
itl=$((idle+iow))
while IFS= read -r l; do
  case $l in
    MemTotal:*) set -- $l; mt=$2 ;;
    MemAvailable:*) set -- $l; ma=$2 ;;
    MemFree:*) set -- $l; mf=$2 ;;
    Buffers:*) set -- $l; bf=$2 ;;
    Cached:*) set -- $l; ca=$2 ;;
    SReclaimable:*) set -- $l; sr=$2 ;;
    SwapTotal:*) set -- $l; spt=$2 ;;
    SwapFree:*) set -- $l; spu=$((spt-$2)) ;;
  esac
done < /proc/meminfo
while IFS= read -r l; do
  case $l in cpu[0-9]*) cores=$((cores+1)) ;; esac
done < /proc/stat
for d in /sys/class/net/*; do
  case \${d##*/} in lo|docker*|veth*|br-*) continue ;; esac
  if [ -r "$d/statistics/rx_bytes" ]; then
    read -r r _ < "$d/statistics/rx_bytes"; rx=$((rx+r))
    read -r x _ < "$d/statistics/tx_bytes"; tx=$((tx+x))
  fi
done
while read -r a1 a2 a3 a4 a5 a6 rest; do
  db=$a2; du=$a3
done <<EOF
$(df -Pk / 2>/dev/null)
EOF
read -r l1 l5 l15 prpt _ < /proc/loadavg
pr=\${prpt%/*}; pt=\${prpt#*/}
read -r up _ < /proc/uptime
echo "P $t1 $i1 $total $itl $mt $ma $db $du $cores $spt $spu $rx $tx $l1 $l5 $l15 $pr $pt $up"
echo "M $mf $bf $ca $sr"
tz=$(cat /etc/timezone 2>/dev/null)
[ -z "$tz" ] && tz=$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')
[ -z "$tz" ] && tz=$(date +%Z 2>/dev/null)
echo "T \${tz:-}"
awk '/^cpu[0-9]+ / { t=0; for(i=2;i<=NF;i++) t+=$i; s=s sprintf(" %d %d", t, $4+$5); n++ } END { if(n>0) print "C " n s }' /proc/stat
lsblk -P -bno NAME,TYPE,PKNAME,SIZE,MOUNTPOINT 2>/dev/null | sed 's/^/L /'
mpts=$(lsblk -no MOUNTPOINT 2>/dev/null | grep '^/')
[ -n "$mpts" ] && df -PTk $mpts 2>/dev/null | awk 'NR>1 { printf "F %s %s %s %s %s", $1, $2, $3, $4, $5; for(i=7;i<=NF;i++) printf " %s", $i; print "" }'
disks=$(lsblk -bndo NAME,TYPE 2>/dev/null | awk '$2=="disk"{print $1}')
awk -v disks="$disks" 'BEGIN { n=split(disks, d, " "); for(i=1;i<=n;i++) want[d[i]]=1 } $3 in want { print "R " $3 " " $6 " " $10 }' /proc/diskstats
. /etc/os-release 2>/dev/null
echo "O \${PRETTY_NAME:-}"`

/** NVIDIA GPU 采集脚本（会话面板的独立低频采样单独跑，**不并进 PERF_SCRIPT** ——
 *  3s 全量采样没必要每次都 fork 一个 nvidia-smi）；输出两段行（gpuPerf.ts 解析）：
 *  "G <index>, <uuid>, <util%>, <memUsedMiB>, <memTotalMiB>, <tempC>, <powerW>, <powerCapW>, <fan%>, <driver>, <name…>"
 *  "A <uuid>, <pid>, <memMiB>, <processPath…>"
 *      两者都是 nvidia-smi CSV 原样透传，含空格的 name/path 固定放最后一项（也避开 path 里的逗号）；
 *      A 行只含计算进程（gnome-shell 这类图形进程不在其中，与 nvidia-smi 进程表口径一致）；
 *  无 nvidia-smi / 无卡的远端无输出（不是错误）；套 timeout 5 兜底，防驱动挂死拖住采样 */
export const GPU_SCRIPT = `if command -v nvidia-smi >/dev/null 2>&1; then
  tmo=""
  command -v timeout >/dev/null 2>&1 && tmo="timeout 5"
  $tmo nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,driver_version,name --format=csv,noheader,nounits 2>/dev/null | sed 's/^/G /'
  $tmo nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,process_name --format=csv,noheader,nounits 2>/dev/null | sed 's/^/A /'
fi`

/** 主机系统名单次采集（会话链路建立后的兜底探测；输出行与 PERF_SCRIPT 的 "O" 行同构） */
export const OS_NAME_SCRIPT = `. /etc/os-release 2>/dev/null
echo "O \${PRETTY_NAME:-}"`

/** 递归删除远端目录（SFTP 删除目录用；对照 Swift remove() 的 rm -rf） */
export function removeDirCommand(path: string): string {
  return `rm -rf -- ${shellQuote(path)}`
}
