/**
 * 格物 · AI 助手设置（设计稿 06 屏）
 *
 * 从「我的 → 整理」进来。这一页要把三件事同时说清，缺一件用户就会犹豫：
 *   ① **要不要花钱** —— 两个模型都是免费档，写在模型行上，不藏在说明里；
 *   ② **数据去哪了** —— 上传的只是 ≤1024px 的压缩副本，原图与库不出手机；
 *   ③ **关掉会怎样** —— 关掉开关等于这一族不存在：首页与录入页的麦克风、
 *      首页的「问一问」星标、录入页的「识物」按钮一起收起来（`/ask`、`/voice`
 *      两个页面本身也挡，深链进不去）。**其它功能一个不少** ——
 *      录入、到期、库存、照片、备份、图库找封面都不受这个开关影响。
 *
 * 用量卡是刻意的：让用户随时看见花了多少钱，他才有底气把开关一直开着。
 * 这里恒为 ¥0.00（两个模型都免费），但那个数字仍然由 `estimateMonthlyCost`
 * 算出来而不是写死 —— 将来换一档模型，它会自己变。
 *
 * 入口已经过一次门控，这一页仍然自带守卫：直接跳进来（比如深链）时，
 * 未激活的档位不该看到一条能开开关的界面。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { AiKeyModal } from '@/components/domain/AiKeyModal';
import { AiEndpointModal, AiModelModal, AiProviderModal } from '@/components/domain/AiProviderModals';
import { SupporterGateSheet } from '@/components/domain/SupporterGateSheet';
import { IconButton } from '@/components/ui/controls';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Label, Meta } from '@/components/ui/typography';
import { Palette, Space } from '@/constants/theme';
import { estimateMonthlyCost } from '@/lib/ai/config';
import { ASR_AVAILABLE } from '@/lib/ai/asr';
import { useAi } from '@/lib/store/ai';
import { useEntitlement } from '@/lib/store/entitlement';
import { makeStyles } from '@/lib/theme';
import { formatMoney } from '@/lib/format';

export default function AiSettingsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { entitled } = useEntitlement();
  const {
    enabled,
    hasKey,
    keyMask,
    usage,
    active,
    setEnabled,
    refresh,
    /* 供应商 / 端点 / 模型名全部来自 store 的 React 状态。
       ★ 不要改回「config 的模块级变量 + 手动计数器」—— 那条路会漏渲染，
         症状正是「明明切过去了，这一行还是旧的」，而且不报错。 */
    provider,
    endpoint,
    visionModel,
    chatModel,
    supportsVision,
    visionOverridden,
    chatOverridden,
  } = useAi();
  const [keyOpen, setKeyOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [endpointOpen, setEndpointOpen] = useState(false);
  /** 正在编辑哪个模型名；null＝不打开 */
  const [modelKind, setModelKind] = useState<'vision' | 'chat' | null>(null);

  const isCustom = provider.key === 'custom';

  const monthCost = estimateMonthlyCost(usage);

  /* 未激活：整页只留一句解释与一个出口。不做成「能看不能按」——
     灰按钮看起来像坏了，而用户真正需要的是知道怎么解锁。 */
  if (!entitled) {
    return (
      <Screen>
        <View style={styles.topBar}>
          <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        </View>
        <PageHeader title="AI 助手" subtitle="识物与问一问属于支持者功能" />
        <Gutter>
          <Card>
            <Body tone="ink2" style={styles.lockedText}>
              AI 助手需要支持者档。免费档的录入、到期、库存、照片与备份全部照旧，一个不少。
            </Body>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/supporter')}
              style={styles.lockedBtn}>
              <Label color={Palette.brand}>去激活 / 了解支持者档</Label>
            </Pressable>
          </Card>
        </Gutter>
        <SupporterGateSheet visible feature="ai" onClose={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" accessibilityLabel="返回" onPress={() => router.back()} />
        <Meta tone="ink3" style={styles.topHint}>
          {active ? '已启用' : '未启用'}
        </Meta>
      </View>

      <PageHeader title="AI 助手" subtitle="识物与问一问都在本机算，只有识别那一刻联网" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SectionCard title="总开关">
          <Gutter>
            <Card padded={false}>
              <View style={styles.switchRow}>
                <View style={styles.switchText}>
                  <Body tone="ink2">启用 AI 助手</Body>
                  <Meta tone="ink4" style={styles.switchDesc}>
                    关闭时不再发出任何 AI 请求，界面上的 AI 入口一并隐藏
                  </Meta>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={(next) => {
                    /* 打开开关但还没 Key：不拦住（那是他的决定），
                       但把 Key 弹层直接递上去 —— 否则他打开开关后回到列表，
                       点识别仍然什么都发生不了，那是最容易让人放弃的一步 */
                    if (next && !hasKey) setKeyOpen(true);
                    void setEnabled(next);
                  }}
                  trackColor={{ false: Palette.line, true: Palette.brandBg }}
                  thumbColor={enabled ? Palette.brand : Palette.surface}
                  accessibilityLabel="启用 AI 助手"
                />
              </View>
            </Card>
          </Gutter>
        </SectionCard>

        <SectionCard title="供应商与凭证">
          <Gutter>
            <Card padded={false}>
              <Row
                label="供应商"
                value={isCustom ? '自定义端点' : provider.name}
                onPress={() => setProviderOpen(true)}
              />
              {isCustom ? (
                <Row
                  label="接口地址"
                  value={endpoint || '未填写，点这里填'}
                  valueTone={endpoint ? 'ink3' : 'brand'}
                  onPress={() => setEndpointOpen(true)}
                />
              ) : null}
              <Row
                label="API Key"
                value={hasKey ? keyMask : '未配置，点这里填'}
                valueTone={hasKey ? 'ink3' : 'brand'}
                onPress={() => setKeyOpen(true)}
                last
              />
            </Card>
            <Meta tone="ink4" style={styles.note}>
              {provider.signupNote}
            </Meta>
            {provider.keyUrl ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void Linking.openURL(provider.keyUrl).catch(() => undefined)}
                style={styles.link}>
                <Ionicons name="open-outline" size={13} color={Palette.brand} />
                <Label tone="brand">打开 {provider.name} 控制台</Label>
              </Pressable>
            ) : null}
          </Gutter>
        </SectionCard>

        <SectionCard title="模型">
          <Gutter>
            <Card padded={false}>
              {/* 两行都可点 —— 模型名是「服务商会改、我们不一定会及时跟」的东西，
                  所以必须让用户自己能填。这家看不了图时识图那行要**明说**，
                  不能只留空，否则用户会以为「是不是没加载出来」 */}
              <Row
                label="识图"
                value={
                  supportsVision
                    ? `${visionModel}${visionOverridden ? '（已改）' : ''}`
                    : '这家看不了图，识物已隐藏'
                }
                valueTone={supportsVision ? 'ink3' : 'clay'}
                onPress={() => setModelKind('vision')}
              />
              <Row
                label="问答"
                value={chatModel ? `${chatModel}${chatOverridden ? '（已改）' : ''}` : '未填写，点这里填'}
                valueTone={chatModel ? 'ink3' : 'brand'}
                onPress={() => setModelKind('chat')}
                last
              />
              {/* 语音单独一行：它与上面两个不是一回事 —— 不需要 Key、不联网、
                  也不申请麦克风权限（走系统识别对话框），**不消耗任何调用量**。
                  ★ 但它与识物、问答同属支持者档，所以这一行的值不写「免费」，
                    否则「免费」会被读成「免费档也能用」 */}
              <Row label="语音" value={ASR_AVAILABLE ? '系统识别 · 不耗 Key' : '这台设备用不了'} last />
            </Card>
            <Meta tone="ink4" style={styles.note}>
              点「识图」或「问答」任意一行，就能改模型名 —— 留空即回到预置的默认值。
              报「模型不存在 / model not found」时，多半是服务商改了名字，到它的文档里抄一个新的填进来就行，
              不必等 App 更新。
            </Meta>
            <Meta tone="ink4" style={styles.note}>
              语音走手机自带的识别对话框，不消耗模型调用，也不需要 API Key。
              ★ 但它与识物、问答同属「智能录入」，共用一个总闸 —— 上面的开关关掉时，
              三处入口会一起收起来（这条与上面那句旧说明相反，见 ROADMAP 的口径记录）。
            </Meta>
          </Gutter>
        </SectionCard>

        <SectionCard title="本月用量">
          <Gutter>
            <Card padded={false} style={styles.usageCard}>
              <View style={styles.usageHead}>
                <Meta tone="ink3">预计花费</Meta>
                <Label style={styles.usageCost}>{`≈ ${formatMoney(monthCost, { decimals: 'always' })}`}</Label>
              </View>
              <View style={styles.usageGrid}>
                <UsageCell label="识别" value={usage.vision} />
                <UsageCell label="问答" value={usage.chat} />
              </View>
              <Meta tone="ink4" style={styles.usageFoot}>
                {usage.vision + usage.chat > 0
                  ? provider.free
                    ? '账单记在你自己账号上；这家有免费档，用多少都是 0'
                    : '账单记在你自己账号上，按用量的实际花费以服务商账单为准'
                  : '还没用过。这里只记调用次数，实际花了多少要看服务商的账单'}
              </Meta>
            </Card>
          </Gutter>
        </SectionCard>

        <SectionCard title="隐私">
          <Gutter>
            <Card>
              <Body tone="ink2" style={styles.privacy}>
                识别时上传的是长边 ≤1024 的压缩副本，用完即弃，服务器上不留存；原图与物品数据始终留在这台手机里。
              </Body>
              <Meta tone="ink4" style={styles.privacy}>
                {/* 换成自选供应商之后，这句话必须写清楚：数据发去哪一家、
                    那一家在不在境内，都由用户自己选 —— 不是格物能替他回答的 */}
                {`上传的目标是你自己选的那家（当前：${isCustom ? '自定义端点' : provider.name}）。`}
                发给哪家、数据落在哪，都由这次选择决定；格物不中转、不留存、也不知道你选了什么。
              </Meta>
              <Meta tone="ink4" style={styles.privacy}>
                Key 存在本机数据库里，不会上传，也不会打进安装包。
              </Meta>
            </Card>
          </Gutter>
        </SectionCard>
      </ScrollView>

      <AiKeyModal
        visible={keyOpen}
        onClose={() => setKeyOpen(false)}
        onSaved={() => void refresh()}
      />

      <AiProviderModal visible={providerOpen} onClose={() => setProviderOpen(false)} />
      <AiEndpointModal visible={endpointOpen} onClose={() => setEndpointOpen(false)} />
      <AiModelModal kind={modelKind} onClose={() => setModelKind(null)} />
    </Screen>
  );
}

/** 一行只读信息。与 SettingRow 长得一样，但这一页的值都比较长，右侧要能换行 */
function Row({
  label,
  value,
  valueTone = 'ink3',
  onPress,
  last,
}: {
  label: string;
  value: string;
  valueTone?: 'brand' | 'ink3' | 'ink' | 'clay';
  onPress?: () => void;
  last?: boolean;
}) {
  const styles = useStyles();
  const color =
    valueTone === 'brand'
      ? Palette.brand
      : valueTone === 'clay'
        ? Palette.clay
        : valueTone === 'ink3'
          ? Palette.ink3
          : Palette.ink;
  const inner = (
    <>
      <Body tone="ink2">{label}</Body>
      <View style={styles.rowRight}>
        <Body color={color} style={styles.rowValue} numberOfLines={1}>
          {value}
        </Body>
        {onPress ? <Ionicons name="chevron-forward" size={16} color={Palette.brand} /> : null}
      </View>
    </>
  );

  if (!onPress) return <View style={[styles.row, !last && styles.rowBorder]}>{inner}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}，${value}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, !last && styles.rowBorder, pressed && styles.rowPressed]}>
      {inner}
    </Pressable>
  );
}

function UsageCell({ label, value }: { label: string; value: number }) {
  const styles = useStyles();
  return (
    <View style={styles.usageCell}>
      <Label style={styles.usageValue}>{String(value)}</Label>
      <Meta tone="ink4">{`${label}次`}</Meta>
    </View>
  );
}

const useStyles = makeStyles((Palette) => ({
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.xs, paddingTop: Space.xs },
  topHint: { marginLeft: Space.xs },
  scroll: { paddingBottom: Space.xxxl },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
  },
  switchText: { flex: 1 },
  switchDesc: { marginTop: 2, lineHeight: 18, fontSize: 12.5 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
    minHeight: 48,
    paddingVertical: Space.sm,
    paddingHorizontal: Space.lg,
  },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Palette.line3 },
  rowPressed: { backgroundColor: Palette.surface2 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 },
  rowValue: { fontWeight: '500', textAlign: 'right' },

  note: { marginTop: Space.sm, paddingHorizontal: Space.lg, lineHeight: 19 },
  link: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, paddingHorizontal: Space.lg, paddingTop: Space.sm },

  usageCard: { padding: Space.lg },
  usageHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  usageCost: { fontSize: 20, fontWeight: '600', color: Palette.brand },
  usageGrid: { flexDirection: 'row', marginTop: Space.md, gap: Space.lg },
  usageCell: { alignItems: 'flex-start' },
  usageValue: { fontSize: 17, fontWeight: '600' },
  usageFoot: { marginTop: Space.md, lineHeight: 19, fontSize: 12.5 },

  privacy: { lineHeight: 21 },
  lockedText: { lineHeight: 21 },
  lockedBtn: { marginTop: Space.md },
}));
