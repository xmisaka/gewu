/**
 * 格物 · 检查更新弹窗（方案页 06 屏）
 *
 * 三条硬口径，都是「别把非强制更新做成强制更新」的落地：
 *   1. **没有倒计时**。「以后再说」是真正可点的次要按钮，不是一闪而过然后自动开下载的幌子。
 *   2. **下载按钮开 APK 直链**（2026-10-10 改口径）。原定「指向官网下载页」，
 *      理由是让用户先看到更新说明与安装说明 —— 如今这两样已完整放在弹窗里
 *      （notes + 覆盖安装提示），官网那一跳只剩成本。APK 与官网同一台服务器，
 *      直链少一跳；清单缺 url 时退回官网页，弹窗底部另留「从官网下载」备用路径。
 *   3. **明说不会丢数据**。这一步很关键：本地优先 App 的用户看到「新版本」三个字，
 *      第一反应往往是「我的几千件东西还在吗」。所以把这句放在按钮上面，
 *      而不是等用户发消息来问。
 */

import { Linking, Modal, Pressable, View } from 'react-native';

import { siteUrlWithSkin } from '@/constants/site';
import { Palette, Radius, Space } from '@/constants/theme';
import { formatVersionChange, type LocalVersion, type UpdateManifest } from '@/lib/update/policy';
import { makeStyles, useTheme } from '@/lib/theme';
import { Button } from '../ui/controls';
import { Body, Heading, Meta } from '../ui/typography';

export interface UpdateSheetProps {
  visible: boolean;
  /** 拿不到清单时不该显示 —— 弹窗的每一行都由它而来 */
  manifest: UpdateManifest | null;
  local: LocalVersion;
  /** 「以后再说」：关掉，且这个版本不再自动弹 */
  onRemindLater: () => void;
  /** 「去下载」：关掉，但**不抑制** —— 用户是打算更新的 */
  onDownloaded: () => void;
}

export function UpdateSheet({ visible, manifest, local, onRemindLater, onDownloaded }: UpdateSheetProps) {
  const styles = useStyles();
  const { key: activeKey } = useTheme();

  if (!manifest) return null;

  /* 直链下载：APK 与官网同一台服务器，浏览器接管下载与安装确认。
     清单没给 url（老清单 / 备用源兜底）就退回官网下载页 —— 按钮不能点空。
     退回官网时带上当前主题（?skin=），官网换肤器会照着换，别让用户从
     App 里跳过去还看到默认的素笺。 */
  const openDirect = () => {
    void Linking.openURL(manifest.url ?? siteUrlWithSkin(activeKey, '#download')).catch(() => {
      // 打不开浏览器（极少数定制系统）不值得弹错误：用户自己会去官网
    });
    onDownloaded();
  };

  /* 备用路径：直链 404、或某些浏览器拦截 APK 下载时，还有官网一跳可走 */
  const openSite = () => {
    void Linking.openURL(siteUrlWithSkin(activeKey, '#download')).catch(() => {});
    onDownloaded();
  };

  /* 遮罩与居中层都用绝对定位、各自一层：
     把弹窗塞进遮罩的 Pressable 里，点弹窗本身也会冒泡上去把它关掉 */
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRemindLater}>
      <Pressable
        style={styles.backdrop}
        onPress={onRemindLater}
        accessibilityRole="button"
        accessibilityLabel="关闭更新提示"
      />

      <View style={styles.center}>
        <View style={styles.dialog}>
          <Heading style={styles.title}>{`格物 ${manifest.versionName}`}</Heading>
          <Meta tone="ink3" style={styles.version}>
            {formatVersionChange(local, manifest)}
          </Meta>

          {manifest.notes.length > 0 ? (
            <View style={styles.notes}>
              {manifest.notes.map((note) => (
                <Body key={note} tone="ink2" style={styles.note}>
                  {note}
                </Body>
              ))}
            </View>
          ) : null}

          <Meta tone="ink4" style={styles.where}>
            {manifest.url ? '点击「去下载」直接获取安装包。' : '下载地址：格物官网'}
          </Meta>
          <Meta tone="ink4" style={styles.where}>
            直接覆盖安装即可，数据不会丢 —— 别先卸载。
          </Meta>

          <View style={styles.actions}>
            <Button
              label="以后再说"
              tone="secondary"
              block={false}
              style={styles.action}
              onPress={onRemindLater}
            />
            <Button label="去下载" block={false} style={styles.action} onPress={openDirect} />
          </View>

          {manifest.url ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="从官网下载"
              onPress={openSite}
              style={styles.alt}>
              <Meta tone="ink4">打不开？从官网下载</Meta>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles(() => ({
  /* 铺满整屏的两层都手写四边而不是用 StyleSheet.absoluteFillObject：
     这个版本的类型里没有 absoluteFillObject，而绝对定位的四条边写出来更直观 */
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: Palette.scrim,
  },

  /* 弹窗略高于正中（06 屏实测 top 168 / 高 203 / 屏高 604）：
     正中偏低会被底部手势区压住，再往上又离标题太远。
     box-none ＝ 这一层自己不接点击、但子元素照接，否则弹窗上的按钮会被它吃掉 */
  center: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'center',
    paddingBottom: 64,
    pointerEvents: 'box-none',
  },

  dialog: {
    marginHorizontal: 28,
    padding: Space.xl,
    borderRadius: Radius.card,
    backgroundColor: Palette.surface,
  },

  title: { fontSize: 19 },
  version: { marginTop: Space.xs },

  /* 说明行距紧一点：这是「一眼扫过」的内容，不是要读的段落 */
  notes: { marginTop: Space.md, gap: 3 },
  note: { lineHeight: 20, fontSize: 13.5 },
  where: { marginTop: Space.sm, lineHeight: 18 },

  actions: { flexDirection: 'row', gap: Space.sm, marginTop: Space.xl },
  action: { flex: 1 },

  /* 备用路径刻意做成「小字弱化」：它是给直链失效的人准备的，
     不能在视觉上和主按钮抢注意力 */
  alt: { alignSelf: 'center', marginTop: Space.md, padding: Space.xs },
}));
