/**
 * 密铺径向布局：把「本机 → 跳板… → 目标」的链折成一棵树，再按「角度 + 分层」两轴铺开。
 *
 * 角度（子树扇区，保证「围绕各自中心」）：叶子按 DFS 顺序平分整圆，跳板取子树叶子的槽位均值 ——
 *   每个跳板正对自己下游那一撮节点的扇形中心；子树之间的角度区间互不重叠，叶子越多区间越宽。
 * 半径（密铺，避免「一圈撑成大圆」）：所有半径都落在 base + (k-1)·gap 的格上（第 k 层）。
 *   节点从「父节点所在层的下一层」起，往最内层试：能进的条件是与该层已放节点的角距
 *   ≥ 该半径下弦距刚好等于 gap 的圆心角。于是密的地方自然往外扩层 —— 一圈铺不下就再扩一圈。
 * 无重叠（纯几何保证，无需碰撞检测）：同层角距 ≥ Δ(R) ⇒ 弦距 ≥ gap；
 *   跨层半径差是 gap 的整数倍 ⇒ 两点距离 ≥ 半径差 ≥ gap。
 * 归属：一个节点只挂一个父节点，取深度最浅者（同深度取 id 最小，直连本机优先）——
 *   多归属节点不被最长的链拖到最外圈；实际连接边由调用方照画，信息不丢。
 */
export function layoutTopology(
  chains: string[][],
  spacing: number,
  nodeSize: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (chains.length === 0) return positions

  const TWO_PI = Math.PI * 2

  /* ---------- ① 建树：只用最浅的那次出现定父节点，保证与链的输入顺序无关 ---------- */
  const parent = new Map<string, string | null>()
  const depth = new Map<string, number>()
  for (const chain of chains) {
    chain.forEach((id, index) => {
      const p = index === 0 ? null : chain[index - 1]
      const d = index + 1
      const cur = depth.get(id)
      if (cur === undefined || d < cur || (d === cur && (p ?? '') < (parent.get(id) ?? ''))) {
        depth.set(id, d)
        parent.set(id, p)
      }
    })
  }

  /* ---------- ② 子节点表与根（排序：同一份拓扑永远得到同一份布局） ---------- */
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const id of depth.keys()) {
    const p = parent.get(id) ?? null
    if (p === null) roots.push(id)
    else children.set(p, [...(children.get(p) ?? []), id])
  }
  for (const kids of children.values()) kids.sort()
  roots.sort()

  /* ---------- ③ 叶子槽位：DFS 顺序平分整圆；跳板取子树的槽位均值 ---------- */
  const slots = new Map<string, number>()
  let leafCount = 0
  const assign = (id: string): number => {
    const kids = children.get(id)
    let slot: number
    if (!kids || kids.length === 0) {
      slot = leafCount++
    } else {
      let sum = 0
      for (const kid of kids) sum += assign(kid)
      slot = sum / kids.length
    }
    slots.set(id, slot)
    return slot
  }
  for (const root of roots) assign(root)
  const step = TWO_PI / Math.max(1, leafCount)
  const angleOf = (id: string): number => -Math.PI / 2 + (slots.get(id) ?? 0) * step
  const byAngle = (a: string, b: string): number => (slots.get(a) ?? 0) - (slots.get(b) ?? 0)

  /* ---------- ④ 密铺：逐节点从最内层往外试，铺不下就扩一层 ---------- */
  const gap = Math.max(120, 90 * nodeSize)
  const base = Math.max(gap, 160 * spacing)
  const radiusOf = (layer: number): number => base + (layer - 1) * gap
  /** 半径 R 上相邻节点所需的最小角宽（弦距刚好等于 gap 的圆心角） */
  const angleNeed = (R: number): number => 2 * Math.asin(Math.min(1, gap / (2 * R)))
  /** 两角之间的短弧角距 */
  const angularGap = (a: number, b: number): number => {
    const d = Math.abs(a - b) % TWO_PI
    return Math.min(d, TWO_PI - d)
  }

  const layers = new Map<number, number[]>()
  const layerOf = new Map<string, number>()
  const place = (id: string, from: number, angle: number): void => {
    for (let k = from; ; k++) {
      const angles = layers.get(k) ?? []
      const need = angleNeed(radiusOf(k))
      if (!angles.every((b) => angularGap(angle, b) >= need)) continue
      angles.push(angle)
      layers.set(k, angles)
      layerOf.set(id, k)
      const r = radiusOf(k)
      positions.set(id, { x: r * Math.cos(angle), y: r * Math.sin(angle) })
      return
    }
  }

  // 按深度逐层处理（父的层号先定，子的起始层才可算）；同深度按角度升序，保证确定性
  let frontier = [...roots].sort(byAngle)
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      const p = parent.get(id) ?? null
      place(id, (p === null ? 0 : (layerOf.get(p) ?? 0)) + 1, angleOf(id))
      for (const kid of children.get(id) ?? []) next.push(kid)
    }
    frontier = next.sort(byAngle)
  }
  return positions
}
