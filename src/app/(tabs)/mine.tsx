/**
 * 格物 · 我的
 *
 * 数据通道是这一页的主角。纯本地存储是单点故障 ——
 * 手机丢了、手滑卸载、系统清缓存，几千件物品和照片一起没，而且找不回来。
 * 所以「备份」必须放在最显眼的位置，且做到一键完成。
 */

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemePickerModal } from '@/components/domain/ThemePickerModal';
import { SettingRow } from '@/components/ui/controls';
import { StockKeyModal, stockKeyStatus } from '@/components/domain/StockKeyModal';
import { Loading, MetricStrip } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { DARK_THEME_KEY, LIGHT_THEME_KEYS, Palette, Radius, Space, THEMES, type ThemeKey } from '@/constants/theme';
import {
  AUTO_BACKUP_INTERVAL_DAYS,
  backupCacheInfo,
  cleanBackupFiles,
  exportItemsCsv,
  previewBackup,
  applyBackup,
  shareBackup,
  daysSinceLastBackup,
  daysSinceAutoBackup,
  BACKUP_FORMAT_VERSION,
  type BackupPreview,
  type ImportStrategy,
  type PreviewOutcome,
} from '@/lib/backup/backup';
import { listAllForExport, listTrash } from '@/lib/db/items';
import { listCategories } from '@/lib/db/categories';
import { listAllPhotos } from '@/lib/db/photos';

import { formatDateCN } from '@/lib/date';
import { formatBytes, formatCount, formatMoney, formatStamp } from '@/lib/format';
import { storageUsage } from '@/lib/photos/pipeline';
import { useAsyncData } from '@/lib/hooks/use-async-data';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles, useTheme } from '@/lib/theme';

/** 版本号从 app.json 读，别在这里手写 —— 手写必然在某次发版后忘记改 */
const APP_VERSION = Constants.expoConfig?.version ?? '—';

/**
 * 色点顺序：四套浅色在前，玄夜压末尾。
 * 玄夜不是「第五个选项」，是系统深色时的接管档 —— 排在末位、不参与点选，
 * 所以只在这里出现，不进选择器的列表。
 */
const THEME_DOT_ORDER: readonly ThemeKey[] = [...LIGHT_THEME_KEYS, DARK_THEME_KEY];

/** 超过这么多天没备份，文案就从「上次备份：XX」换成催的口径 */
const BACKUP_STALE_DAYS = 30;

export default function MineScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { stats, dataVersion, bump } = useAppState();
  const { key: activeKey, lightKey, setLightKey, systemDark } = useTheme();
  const activeTheme = THEMES[activeKey];
  const [busy, setBusy] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  /** 本机备份包被清理后 +1，只用来让上面的 metaState 重取一次 */
  const [cacheTick, setCacheTick] = useState(0);

  const metaState = useAsyncData(
    async () => {
      const [items, photos, categories] = await Promise.all([
        listAllForExport(),
        listAllPhotos(),
        listCategories(),
      ]);
      const trash = await listTrash();
      // 与其它统计一趟读回，避免挂载后再多一次异步把界面顶一下
      const [backupDays, autoDays] = await Promise.all([daysSinceLastBackup(), daysSinceAutoBackup()]);
      return {
        items: items.length,
        photos: photos.length,
        trash: trash.length,
        categories: categories.length,
        storage: storageUsage(),
        backupDays,
        autoDays,
        backupFiles: backupCacheInfo(),
        earliest: items.reduce<number | null>(
          (min, it) => (min == null || it.createdAt < min ? it.createdAt : min),
          null,
        ),
      };
    },
    // 清理本机备份包只动文件、不动库，所以不进 dataVersion，用本页自己的计数重取
    [dataVersion, cacheTick],
    null,
  );

  const runBackup = async () => {
    setBusy('backup');
    try {
      const result = await shareBackup();
      Alert.alert(
        '备份包已生成',
        `${result.fileName}\n${formatBytes(result.bytes)}\n含 ${result.manifest.counts.items} 件物品、${result.manifest.counts.photos} 张照片。\n\n建议发到微信文件传输助手或存进网盘，别只留在手机里。`,
      );
    } catch (err) {
      Alert.alert('备份失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setBusy(null);
    }
  };

  /**
   * 清理本机（cache）里的备份包，只留最新的一份。
   *
   * 自动备份会按份数 + 字节预算自己淘汰，用户本不必管这个；
   * 这个入口是给「我现在就要腾空间」用的，所以口径比自动策略更狠（只留一份），
   * 并在确认框里把「删的是缓存里的副本、已分享出去的包不受影响」写清楚 ——
   * 否则用户看到「清理备份」四个字，第一反应是怕把备份删没了。
   */
  const runCleanBackups = () => {
    const info = backupCacheInfo();
    if (info.count === 0) return;
    Alert.alert(
      '清理本机备份包？',
      [
        `本机有 ${info.count} 份，共 ${formatBytes(info.bytes)}。`,
        '清理后只保留最新的一份。',
        '',
        '这些是 App 缓存目录里的副本；已经发到微信或存进网盘的备份不受影响。',
      ].join('\n'),
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
          style: 'destructive',
          onPress: () => {
            const result = cleanBackupFiles();
            setCacheTick((t) => t + 1);
            Alert.alert(
              result.removed > 0 ? '已清理' : '没什么可清理的',
              result.removed > 0
                ? `删掉 ${result.removed} 份，腾出 ${formatBytes(result.freedBytes)}。`
                : '本机只剩一份备份包了。',
            );
          },
        },
      ],
    );
  };

  const runExport = async () => {
    setBusy('export');
    try {
      const result = await exportItemsCsv();
      Alert.alert('清单已导出', `${result.fileName}\n共 ${result.rows} 行，双击即可用 Excel / WPS 打开。`);
    } catch (err) {
      Alert.alert('导出失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    /* 先读包、再问策略。原来是先问策略再选文件 —— 用户在盲选：
       选完才知道包里是几件东西、什么时候的，而这个动作已经执行完了 */
    setBusy('preview');
    let outcome: PreviewOutcome;
    try {
      outcome = await previewBackup();
    } catch (err) {
      setBusy(null);
      Alert.alert('导入失败', err instanceof Error ? err.message : '未知错误');
      return;
    }
    setBusy(null);

    if (outcome.kind === 'canceled') return;
    if (outcome.kind === 'error') {
      Alert.alert('无法读取这个备份包', outcome.error);
      return;
    }

    const preview = outcome.preview;
    Alert.alert(
      '这份备份包里有什么',
      [
        preview.fileName,
        `备份时间：${formatStamp(preview.manifest.createdAt)}`,
        `物品 ${preview.counts.items} 件 · 分类 ${preview.counts.categories} 个 · 位置 ${preview.counts.locations} 个`,
        `照片 ${preview.counts.photos} 张（${formatBytes(preview.photoBytes)}）`,
        '',
        `本机现有 ${stats.total} 件物品。要怎么合？`,
      ].join('\n'),
      [
        { text: '取消', style: 'cancel' },
        { text: '合并', onPress: () => void doImport(preview, 'merge') },
        { text: '覆盖', style: 'destructive', onPress: () => confirmReplace(preview) },
      ],
    );
  };

  /* 覆盖是不可撤销的，所以单独再确认一次，并且把要抹掉的数字写出来 */
  const confirmReplace = (preview: BackupPreview) => {
    Alert.alert(
      '确认覆盖？',
      `本机现有的 ${stats.total} 件物品、柜子和照片会先被清空，然后从这份备份还原。这个操作不可撤销。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '确认覆盖', style: 'destructive', onPress: () => void doImport(preview, 'replace') },
      ],
    );
  };

  const doImport = async (preview: BackupPreview, strategy: ImportStrategy) => {
    setBusy('import');
    try {
      const result = await applyBackup(preview, strategy);
      if (result.error) {
        Alert.alert('导入失败', result.error);
        return;
      }
      bump();
      const w = result.written;
      Alert.alert(
        '导入完成',
        [
          `物品 ${w?.items ?? 0} 件`,
          `分类 ${w?.categories ?? 0} 个`,
          `位置 ${w?.locations ?? 0} 个`,
          `照片 ${w?.photos ?? 0} 张（文件 ${w?.photoFiles ?? 0} 个）`,
          w && w.skipped > 0 ? `跳过已存在 ${w.skipped} 条` : '',
          w && w.prunedFiles > 0 ? `顺带清掉 ${w.prunedFiles} 个没人引用的照片文件` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (err) {
      Alert.alert('导入失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setBusy(null);
    }
  };

  const meta = metaState.data;

  const backupDays = meta?.backupDays ?? null;
  const relativeDays = (days: number | null): string =>
    days == null ? '—' : days === 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;

  const backupWhen = backupDays == null ? '还没备份过' : relativeDays(backupDays);
  /* 从没备份过、或者拖过了一个月，都算「该再备一次」：
     这张卡平时是提醒，只有到这一步才需要真的劝 */
  const backupStale = backupDays == null || backupDays >= BACKUP_STALE_DAYS;
  const backupTitle =
    backupDays == null
      ? '还没有备份过'
      : backupStale
        ? `上次备份：${backupWhen}，该再备一次`
        : `上次备份：${backupWhen}`;

  const backupDesc =
    backupDays == null
      ? stats.total > 0
        ? `这 ${stats.total} 件物品还没有任何副本。手机丢了或误卸载，就一起没了。`
        : '这块数据不联网、也没有云端副本。手机丢了或误卸载，几千件物品和照片会一起没。'
      : backupStale
        ? `距上次备份已经 ${backupDays} 天，这期间录入和修改的东西都还没有副本。`
        : '这块数据不联网、也没有云端副本。手机丢了或误卸载，几千件物品和照片会一起没。';

  /* 自动备份的状态是**另一条**信息，不能并进上面那张卡：
     上面说的是「包有没有离开这台手机」（这才是防丢），
     自动备份只是本机 cache 里的一份回滚副本，手机丢了照样没。 */
  const autoDays = meta?.autoDays ?? null;
  const autoNote =
    autoDays == null
      ? `自动备份：每 ${AUTO_BACKUP_INTERVAL_DAYS} 天往本机存一份`
      : `自动备份：已于 ${relativeDays(autoDays)}存到本机`;

  const backupFiles = meta?.backupFiles ?? { count: 0, bytes: 0 };

  return (
    <Screen>
      <PageHeader title="我的" subtitle="数据都在这台手机里，请留意备份" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Gutter>
          {/* 三格居中，按方案页的概览形态。
              总价值与占用空间挪到下面那行小字里，不为对齐三格把有用信息丢掉 */}
          <Card padded={false} style={styles.overview}>
            <MetricStrip
              framed={false}
              metrics={[
                { label: '物品', value: formatCount(stats.total) },
                { label: '照片', value: meta ? formatCount(meta.photos) : '—' },
                { label: '回收站', value: meta ? formatCount(meta.trash) : '—' },
              ]}
            />
            <Meta tone="ink4" style={styles.overviewFoot}>
              {`共 ${formatMoney(stats.totalValue)}`}
              {meta ? ` · 占用 ${formatBytes(meta.storage.total)}` : ''}
              {meta?.earliest
                ? ` · 第一件录于 ${formatDateCN(new Date(meta.earliest).toISOString().slice(0, 10))}`
                : ''}
            </Meta>
          </Card>
        </Gutter>

        <SectionCard title="数据通道">
          {/* 卡片本身要左右留白（方案页的 .card 是 margin:11px 17px 0）。
              边距由外层 Gutter 给，卡片就不再自己扛 marginHorizontal —— 否则两处叠加 */}
          <Gutter>
            <Card padded={false}>
              <SettingRow
                label="生成备份包"
                value={busy === 'backup' ? '处理中…' : backupWhen}
                valueTone={backupStale ? 'brand' : 'ink3'}
                onPress={runBackup}
              />
              <SettingRow
                label="导出物品清单"
                value={busy === 'export' ? '处理中…' : 'CSV'}
                valueTone="ink3"
                onPress={runExport}
              />
              <SettingRow
                label="导入备份"
                value={busy === 'preview' ? '正在读包…' : busy === 'import' ? '处理中…' : undefined}
                last={backupFiles.count === 0}
                onPress={runImport}
              />
              {/* 只在真有本机备份包时出现：新装用户看到一行「暂无」只是噪声 */}
              {backupFiles.count > 0 ? (
                <SettingRow
                  label="清理本地备份包"
                  value={`${backupFiles.count} 个 · ${formatBytes(backupFiles.bytes)}`}
                  valueTone="ink3"
                  last
                  onPress={runCleanBackups}
                />
              ) : null}
            </Card>

            <Meta tone="ink4" style={styles.autoNote}>
              {autoNote}
            </Meta>

            {/* 品牌卡（方案页的 brandcard）：备份是这件事里唯一「不做就会永久丢」的动作，
                该被显眼地提出来，而不是混在一行设置里 */}
            <View style={styles.backupCard}>
              <Body color={Palette.brandDeep} style={styles.backupTitle}>
                {backupTitle}
              </Body>
              <Meta color={Palette.brand} style={styles.backupDesc}>
                {backupDesc}
              </Meta>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="立即生成备份包"
                onPress={busy ? undefined : runBackup}
                android_ripple={{ color: Palette.rippleOnAccent }}
                style={({ pressed }) => [styles.backupBtn, pressed && styles.backupBtnPressed]}>
                <Label color={Palette.onAccent} style={styles.backupBtnText}>
                  {busy === 'backup' ? '正在打包…' : '立即备份'}
                </Label>
              </Pressable>
            </View>
          </Gutter>
        </SectionCard>

        <SectionCard title="整理">
          <Gutter>
            <Card padded={false}>
              <SettingRow label="柜子与格位" onPress={() => router.push('/cabinet/new')} />
              <SettingRow
                label="分类管理"
                value={meta ? `${meta.categories} 个` : undefined}
                valueTone="ink3"
                onPress={() => router.push('/category')}
              />
              <SettingRow
                label="封面图源"
                value={stockKeyStatus()}
                valueTone="ink3"
                onPress={() => setKeyOpen(true)}
              />
              <SettingRow
                label="回收站"
                value={meta && meta.trash > 0 ? `${meta.trash} 件待处理` : '空的'}
                valueTone={meta && meta.trash > 0 ? 'brand' : 'ink3'}
                onPress={() => router.push('/trash')}
                last
              />
            </Card>
          </Gutter>
        </SectionCard>

        <SectionCard title="外观">
          <Gutter>
            <Card padded={false}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`外观主题，当前为${activeTheme.name}`}
                onPress={() => setThemeOpen(true)}
                android_ripple={{ color: Palette.ripple }}
                style={({ pressed }) => [styles.themeRow, pressed && styles.rowPressed]}>
                <Body tone="ink2">外观主题</Body>
                <View style={styles.themeValue}>
                  <Body color={Palette.brand} style={styles.themeValueText}>
                    {activeTheme.name}
                  </Body>
                  <Ionicons name="chevron-forward" size={16} color={Palette.brand} />
                </View>
              </Pressable>

              {/* 五枚色点，当前生效的那枚戴一圈墨色环 —— 环下垫 2px 卡片面，
                  与圆点之间留出空隙，深色档下才不会糊成一坨 */}
              <View style={styles.dots}>
                {THEME_DOT_ORDER.map((themeKey) => (
                  <View
                    key={themeKey}
                    style={[styles.dotRing, themeKey === activeKey && styles.dotRingOn]}>
                    <View style={[styles.dot, { backgroundColor: THEMES[themeKey].tokens.brand }]} />
                  </View>
                ))}
              </View>
            </Card>

            <Card tone="inset" style={styles.themeTip}>
              <Body tone="ink2" style={styles.warnText}>
                {systemDark
                  ? '系统当前是深色模式，四套浅色暂时不生效 —— 界面正用「玄夜」。关掉系统深色就能看到所选配色。'
                  : '四套浅色随你挑。系统切到深色时，界面会自动换成「玄夜」，不用另外设置。'}
              </Body>
            </Card>
          </Gutter>
        </SectionCard>

        <SectionCard title="关于">
          <Gutter>
            <Card>
              <Title style={styles.aboutName}>格物</Title>
              <Meta tone="ink3" style={styles.aboutLine}>
                本地优先 · 数据不出手机 · 仅找封面时联网
              </Meta>
              <Meta tone="ink4" style={styles.aboutLine}>
                版本 {APP_VERSION}（V1）· 数据格式 v{BACKUP_FORMAT_VERSION}
              </Meta>
            </Card>
          </Gutter>
        </SectionCard>

        {busy ? (
          <View style={styles.busyRow}>
            <Loading
              label={
                busy === 'backup'
                  ? '正在打包…'
                  : busy === 'export'
                    ? '正在导出…'
                    : busy === 'preview'
                      ? '正在读取备份包…'
                      : '正在导入…'
              }
            />
          </View>
        ) : null}
      </ScrollView>

      <ThemePickerModal
        visible={themeOpen}
        value={lightKey}
        systemDark={systemDark}
        onClose={() => setThemeOpen(false)}
        onPick={(next) => {
          setLightKey(next);
          setThemeOpen(false);
        }}
      />

      <StockKeyModal
        visible={keyOpen}
        onClose={() => setKeyOpen(false)}
        // 关闭时 setKeyOpen 会触发重渲染，状态行自然会去读最新 Key，
        // 所以这里不需要额外的版本号把界面顶一下
        onSaved={() => undefined}
      />
    </Screen>
  );
}

/* ------------------------------------------------------------ 样式 */

const useStyles = makeStyles((Palette) => ({
  scroll: { paddingBottom: 120 },

  /* 概览：三格居中（MetricStrip 裸壳）+ 底部一行小字兜住其余数字 */
  overview: { paddingTop: Space.xs, paddingBottom: Space.md },
  overviewFoot: {
    paddingHorizontal: Space.lg,
    marginTop: Space.xs,
    textAlign: 'center',
  },

  warnText: { lineHeight: 20, fontSize: 13 },

  /* 数据通道卡下面那行自动备份状态：与设置行的文字左对齐（行内距是 Space.lg），
     贴着卡片下沿，别抢品牌卡的注意力 */
  autoNote: { marginTop: Space.sm, paddingHorizontal: Space.lg },

  /* 备份品牌卡。左右边距由外层的 Gutter 给，这里不再自己扛
     —— 两处都写会叠成 34px，比方案页的 17px 宽一倍 */
  backupCard: {
    marginTop: Space.md,
    backgroundColor: Palette.brandBg,
    borderRadius: Radius.card,
    padding: Space.md,
  },
  backupTitle: { fontWeight: '500' },
  backupDesc: { marginTop: 2, lineHeight: 20, fontSize: 12.5 },
  backupBtn: {
    marginTop: Space.md,
    backgroundColor: Palette.brand,
    borderRadius: Radius.thumb,
    paddingVertical: Space.sm,
    alignItems: 'center',
  },
  backupBtnPressed: { opacity: 0.88 },
  backupBtnText: { fontWeight: '600' },

  /* 外观主题：一行入口 + 一排色点指示器 */
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Space.md,
    paddingVertical: Space.md,
    paddingHorizontal: Space.lg,
  },
  themeValue: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  themeValueText: { fontWeight: '500' },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 9,
    paddingTop: 13,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
  /* 环平时透明、选中才染色。透明那一档不能省，否则选中时圆点会被环挤动一下 */
  dotRing: { padding: 2, borderRadius: 999, borderWidth: 1.5, borderColor: 'transparent' },
  dotRingOn: { borderColor: Palette.ink2 },
  dot: { width: 26, height: 26, borderRadius: 13 },
  themeTip: { marginTop: Space.md, padding: Space.md },

  /* 行被按下时的反馈，供设置行与外观入口共用 */
  rowPressed: { backgroundColor: Palette.surface2 },

  aboutName: { fontSize: 18, marginBottom: Space.xs },
  aboutLine: { marginTop: 2 },
  busyRow: { paddingTop: Space.lg },
}));
