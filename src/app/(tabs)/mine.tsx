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
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ContactSection } from '@/components/domain/ContactSection';
import { ThemePickerModal } from '@/components/domain/ThemePickerModal';
import { SettingRow } from '@/components/ui/controls';
import { StockKeyModal, stockKeyStatus } from '@/components/domain/StockKeyModal';
import { SupporterGateSheet } from '@/components/domain/SupporterGateSheet';
import { Loading, MetricStrip, PlainTag } from '@/components/ui/feedback';
import { Card, Gutter, PageHeader, Screen, SectionCard } from '@/components/ui/layout';
import { Body, Label, Meta, Title } from '@/components/ui/typography';
import { DARK_THEME_KEY, LIGHT_THEME_KEYS, Palette, Radius, Space, THEMES, type ThemeKey } from '@/constants/theme';
import { AFDIAN_URL, SITE_URL, siteUrlWithSkin } from '@/constants/site';
import { isThemeLocked, type SupporterFeature } from '@/lib/entitlement';
import { useEntitlement } from '@/lib/store/entitlement';
import { useUpdate } from '@/lib/store/update';
import { updateStatusText } from '@/lib/update/policy';
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
import { useAi } from '@/lib/store/ai';
import { useAppState } from '@/lib/store/app-state';
import { makeStyles, useTheme } from '@/lib/theme';

/** 版本号从 app.json 读，别在这里手写 —— 手写必然在某次发版后忘记改 */
const APP_VERSION = Constants.expoConfig?.version ?? '—';

/**
 * 色点顺序：六套浅色在前，玄夜压末尾。
 * 玄夜不是「第七个选项」，是系统深色时的接管档 —— 排在末位、不参与点选，
 * 所以只在这里出现，不进选择器的列表。
 */
const THEME_DOT_ORDER: readonly ThemeKey[] = [...LIGHT_THEME_KEYS, DARK_THEME_KEY];

/** 超过这么多天没备份，文案就从「上次备份：XX」换成催的口径 */
const BACKUP_STALE_DAYS = 30;

export default function MineScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { stats, dataVersion, bump } = useAppState();
  const { key: activeKey, lightKey, lightKeyLocked, preferredLightKey, setLightKey, systemDark } =
    useTheme();
  const { entitled } = useEntitlement();
  const { active: aiActive, hasKey: aiHasKey } = useAi();
  const { status, local, checkNow } = useUpdate();
  const activeTheme = THEMES[activeKey];
  const [busy, setBusy] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  /** 本机备份包被清理后 +1，只用来让上面的 metaState 重取一次 */
  const [cacheTick, setCacheTick] = useState(0);
  /** 被挡下的功能（null = 不显示门控浮层）。目前只有皮肤会走到这里 */
  const [gateFeature, setGateFeature] = useState<SupporterFeature | null>(null);
  /** 用户在选择器里点到的那套皮肤，带进激活页，激活完就地生效 */
  const [gateTheme, setGateTheme] = useState<ThemeKey | null>(null);

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

  /* 「AI 助手」那一行右侧的状态。四种情形对用户的含义完全不同，
     所以不能笼统写成「可用 / 不可用」：
     ★ 「未配置」与「已关闭」必须分开 —— 前者要去填 Key，后者只要把开关打开，
       写成同一句话会让已经配好的人再去找一遍 Key。 */
  const aiRowValue = !entitled
    ? '支持者功能'
    : aiActive
      ? '已开启'
      : aiHasKey
        ? '已关闭'
        : '未配置';
  const aiRowTone = aiActive ? 'brand' : 'ink3';

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
              {/* 统计排在「分类管理」后面、不挂在最前：它是「整理完了想看看」的收尾动作，
                  不是每天要点的入口。行尾不给计数 —— 那些数字要在页内展开才有意义 */}
              <SettingRow label="统计洞察" onPress={() => router.push('/stats')} />
              <SettingRow
                label="封面图源"
                value={stockKeyStatus()}
                valueTone="ink3"
                onPress={() => setKeyOpen(true)}
              />
              {/* AI 助手紧跟在「封面图源」后面：两行都是「填一个自己的 Key 换一项联网能力」，
                  摆在一起用户才容易理解它们的共同点 —— 都是你申请、格物不代管。
                  免费档点它弹门控浮层（而不是藏掉），理由同 01 屏那枚星标。 */}
              <SettingRow
                label="AI 助手"
                value={aiRowValue}
                valueTone={aiRowTone}
                onPress={() => {
                  if (entitled) router.push('/ai');
                  else setGateFeature('ai');
                }}
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

              {/* 七枚色点，当前生效的那枚戴一圈墨色环 —— 环下垫 2px 卡片面，
                  与圆点之间留出空隙，深色档下才不会糊成一坨。
                  免费档下会员那三枚降透明度：指示器也要说实话，不能摆出「都可用」的样子 */}
              <View style={styles.dots}>
                {THEME_DOT_ORDER.map((themeKey) => (
                  <View
                    key={themeKey}
                    style={[styles.dotRing, themeKey === activeKey && styles.dotRingOn]}>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: THEMES[themeKey].tokens.brand },
                        isThemeLocked(themeKey, entitled) && styles.dotLocked,
                      ]}
                    />
                  </View>
                ))}
              </View>
            </Card>

            <Card tone="inset" style={styles.themeTip}>
              <Body tone="ink2" style={styles.warnText}>
                {lightKeyLocked
                  ? `你之前选的「${THEMES[preferredLightKey].name}」属于支持者功能，现在按「素笺」显示。激活之后它会自动回来，不用再选一次。`
                  : systemDark
                    ? '系统当前是深色模式，六套浅色暂时不生效 —— 界面正用「玄夜」。关掉系统深色就能看到所选配色。'
                    : entitled
                      ? '六套浅色全都解锁了。系统切到深色时，界面会自动换成「玄夜」，不用另外设置。'
                      : '「素笺」「靛青」「青瓷」免费；另外三套属于支持者功能。系统切到深色时，界面会自动换成「玄夜」，不用另外设置。'}
              </Body>
            </Card>
          </Gutter>
        </SectionCard>

        {/* 「支持格物」不放在最上面：这一页的第一顺位是备份（不做会永久丢数据），
            付费入口排在它后面，是刻意的顺序 */}
        <SectionCard title="支持格物">
          <Gutter>
            <Card padded={false}>
              {AFDIAN_URL.length > 0 ? (
                <SettingRow
                  label="去爱发电支持"
                  value="¥28 一次买断"
                  onPress={() => router.push('/supporter')}
                />
              ) : null}
              <SettingRow
                label="支持者状态"
                value={entitled ? '已激活 · 不限设备' : '未激活'}
                valueTone={entitled ? 'brand' : 'ink3'}
                onPress={() => router.push('/supporter')}
              />
              {/* 按方案页 04 屏，这一行落在「支持格物」卡里（而不是「关于」）——
                  对一个没有商店的 App 来说，「支持我」和「有新版本去哪拿」是同一件事的两面。
                  检查中不再响应点击：连点两次等于开两次网，结果却一样 */}
              <SettingRow
                label="检查更新"
                value={updateStatusText(status, local)}
                valueTone={status === 'available' ? 'brand' : 'ink3'}
                last
                onPress={status === 'checking' ? undefined : () => void checkNow()}
              />
            </Card>

            <Meta tone="ink4" style={styles.supportNote}>
              {entitled
                ? '激活码不绑设备、不限台数，换手机再粘一次即可，不需要联网。仅限本人使用，请勿外传。'
                : '支持者档一次买断，不影响免费档 —— 收纳、到期、库存、照片、备份恢复全部照旧。'}
            </Meta>
          </Gutter>
        </SectionCard>

        <SectionCard title="关于">
          <Gutter>
            <Card>
              <View style={styles.aboutHead}>
                <Title style={styles.aboutName}>格物</Title>
                <PlainTag text={entitled ? '支持者版' : '免费版'} tone={entitled ? 'brand' : 'neutral'} />
              </View>
              <Meta tone="ink3" style={styles.aboutLine}>
                本地优先 · 数据不出手机 · 仅找封面时联网
              </Meta>
              <Meta tone="ink4" style={styles.aboutLine}>
                版本 {APP_VERSION}（V2）· 数据格式 v{BACKUP_FORMAT_VERSION}
              </Meta>
              {/* 这两句必须同时出现，否则「AI 属于支持者档」看起来与「AI 不收费」自相矛盾：
                  门控的是功能入口，不是调用量；Key 始终是用户自己的，账记在他自己的账号上 */}
              <Meta tone="ink4" style={styles.aboutLine}>
                支持者档包含 AI 功能入口；AI 的 Key 由你自己申请、调用量记在你自己的账号上，格物不代出 Key、也不按量收费。
              </Meta>
            </Card>

            {/* 官网放在「关于」而不是「联系我」：它是 App 的身份入口（介绍、更新说明、
                下载页都在这里），找官网的人第一眼看的是「关于」；
                想找我本人的人才去看微信。两件事别塞进同一张卡 */}
            <Card padded={false} style={styles.siteCard}>
              <SettingRow
                label="官网"
                value={SITE_URL.replace(/^https?:\/\//, '')}
                valueTone="ink3"
                last
                /* 打不开浏览器（极少数定制系统）不值得弹错误：
                   地址已经写在行尾，用户看得见、也抄得下来 */
                onPress={() => void Linking.openURL(siteUrlWithSkin(activeKey)).catch(() => undefined)}
              />
            </Card>
          </Gutter>
        </SectionCard>

        <ContactSection />

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
        // 点到被挡下的那套：先关选择器再弹门控 ——
        // 两个 Modal 叠在一起在安卓上会互相抢返回键
        onLockedPick={(next) => {
          setThemeOpen(false);
          setGateTheme(next);
          setGateFeature('theme');
        }}
      />

      <SupporterGateSheet
        visible={gateFeature !== null}
        feature={gateFeature ?? 'theme'}
        themeIntent={gateTheme ?? undefined}
        onClose={() => {
          setGateFeature(null);
          setGateTheme(null);
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
    /* 七枚点是本页最挤的一行：360dp 屏刚好一行放下（7×29 + 6×7 = 245），
       320dp 的老机型会差几个像素 —— 所以缩了点径、收窄了间距，
       并留一个换行兜底。宁可挤成两行，也不能溢出被裁掉。 */
    gap: 7,
    rowGap: 7,
    flexWrap: 'wrap',
    paddingTop: 13,
    paddingBottom: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.line3,
  },
  /* 环平时透明、选中才染色。透明那一档不能省，否则选中时圆点会被环挤动一下 */
  dotRing: { padding: 2, borderRadius: 999, borderWidth: 1.5, borderColor: 'transparent' },
  dotRingOn: { borderColor: Palette.ink2 },
  /* 22 而不是 26：六套之后这一行放 7 枚点，26 会在 320dp 屏上溢出 */
  dot: { width: 22, height: 22, borderRadius: 11 },
  /* 免费档下另外三枚色点降透明度，与选择器里的处理保持一致 */
  dotLocked: { opacity: 0.45 },
  themeTip: { marginTop: Space.md, padding: Space.md },

  supportNote: { marginTop: Space.sm, paddingHorizontal: Space.lg, lineHeight: 19 },

  /* 行被按下时的反馈，供设置行与外观入口共用 */
  rowPressed: { backgroundColor: Palette.surface2 },

  aboutHead: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginBottom: Space.xs },
  aboutName: { fontSize: 18 },
  aboutLine: { marginTop: 2 },
  siteCard: { marginTop: Space.md },
  busyRow: { paddingTop: Space.lg },
}));
