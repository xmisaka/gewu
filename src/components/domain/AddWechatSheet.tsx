/**
 * 格物 · 加我微信
 *
 * 「我的」页 / 权益页 / 支持者页点「加我微信」弹的就是它。
 * 门控浮层那边不叠第二个面板 —— Android 上 RN 的 Modal 是一个独立的 Dialog 窗口，
 * 套在里面再开一个 Modal 行为不可靠；那边改成**原地把内容换成** `AddWechatBody`
 * （见 SupporterGateSheet）。所以这个文件把「面板外壳」和「内容」分开导出。
 *
 * ────────────────────────────────────────────────────────────────
 * ★★★ 分享出去的是**二维码图片**，不是那条链接 —— 这条踩过坑，别改回去。
 *
 *   2026-10-12 实测 + 三条独立来源：**微信没有「点链接加好友」这条路**。
 *   个人名片码被外部工具解析出来的那串 `u.wechat.com/…` 链接，
 *   在系统浏览器里 301 跳到微信官网（web 层根本没有落地页），
 *   在微信里点开**同样打不开** —— 名片码只有「扫一扫」与「图片识别」两条线认。
 *
 *   v2.3.0 曾把这里改成「分享链接」，依据是「点一下比长按识别本能」；
 *   那个依据是错的（当时引的两处网络来源不可靠），结果是每个点了它的人都加不上，
 *   而且**全程不报错**。现在改回分享图片（`shareWechatQr()`，v2.0.0 起就有）。
 *
 * ★★ 面板里三条路并排，谁也不依赖谁：
 *    · 二维码图片 → 分享进微信，对方**长按这张图**选「识别图中二维码」；
 *    · 二维码本身 → 有第二台设备（电脑 / 平板 / 家人在旁边）的人直接扫；
 *    · 微信号      → 前两条都走不通时兜底（也绕开了「二维码被重置」这件事）。
 *
 * ★ 放大态**不是第二个 Modal**，是本组件内的一次视图切换。理由同上：
 *   它可能被渲染在门控浮层的 Modal 里面，再套一层 Dialog 会出问题。
 */

import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Palette, Radius, Space } from '@/constants/theme';
import { WECHAT_ID, WECHAT_NAME } from '@/constants/site';
import { shareWechatQr, WECHAT_QR } from '@/lib/contact';
import { makeStyles } from '@/lib/theme';
import { Button } from '../ui/controls';
import { Body, Heading, Meta } from '../ui/typography';
import { SheetModal } from '../ui/sheet-modal';

/** 常态二维码边长。与「联系我」那张卡一致，用户在两处看到的码一样大 */
const QR_SIZE = 200;
/** 放大态边长。最窄的机型也放得下（264 + 两边留白 < 360） */
const QR_ZOOM_SIZE = 264;

export interface AddWechatBodyProps {
  /**
   * 退出这件事做什么。
   * 面板里＝关闭面板；门控浮层里＝切回原来那段权益说明。
   * 不传就整条不渲染（比如将来嵌进某个不能关的地方）。
   */
  onDone?: () => void;
  /** 退出按钮的措辞。门控浮层那边传「返回」，因为退出的是「加微信」这段视图 */
  doneLabel?: string;
}

/**
 * 面板内容。单独导出，好让门控浮层原地复用它，而不必开第二个 Modal。
 */
export function AddWechatBody({ onDone, doneLabel = '稍后再说' }: AddWechatBodyProps) {
  const styles = useStyles();
  const [zoomed, setZoomed] = useState(false);
  const [sharing, setSharing] = useState(false);

  const onShare = async () => {
    setSharing(true);
    try {
      /* ★★ 分享的是**图片**，不是链接（理由见文件头）。
         交给系统分享面板 → 用户选微信 → 对方在聊天里长按这张图 → 识别图中二维码。 */
      const ok = await shareWechatQr();
      /* false ＝ 这台设备没有分享面板（罕见机型）。不打断：
         二维码就在上面、微信号也在，用户自己会走另外两条路。 */
      if (!ok) console.warn('[gewu] 这台设备没有分享面板，走二维码/微信号那条路');
    } catch (err) {
      /* 分享面板报错多半是目标应用崩了或者用户中途取消。同样不弹 Alert 打断。 */
      console.warn('[gewu] 分享二维码失败：', err);
    } finally {
      setSharing(false);
    }
  };

  if (zoomed) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="返回"
        onPress={() => setZoomed(false)}
        style={styles.zoomWrap}>
        <Heading style={styles.zoomName}>{WECHAT_NAME}</Heading>
        <View style={styles.zoomPlate}>
          <Image source={WECHAT_QR} style={styles.zoomQr} contentFit="contain" />
        </View>
        <Meta tone="ink3" style={styles.zoomHint}>
          用另一台手机的微信扫一扫 · 点二维码返回
        </Meta>
      </Pressable>
    );
  }

  return (
    <>
      <View style={styles.head}>
        <Heading style={styles.title}>加我微信获取激活码</Heading>
        <Meta tone="ink3" style={styles.sub}>
          ¥36 一次买断 · 免费档照旧
        </Meta>
      </View>

      {/* ★ 名字写在白底板**外面**：底板恒为 pure（固定白），
          名字要是也放进去就只能用写死的深色值 —— 深色主题下白字压白底直接看不见，
          而且不报错。放在外面就能用主题感知的 ink。 */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="放大微信二维码"
        onPress={() => setZoomed(true)}
        android_ripple={{ color: Palette.ripple }}
        style={({ pressed }) => [styles.plate, pressed && styles.platePressed]}>
        <Image source={WECHAT_QR} style={styles.qr} contentFit="contain" />
      </Pressable>

      <Heading style={styles.name}>{WECHAT_NAME}</Heading>
      <Meta tone="ink4" style={styles.hint}>
        点二维码可放大 · 有另一台设备就直接扫
      </Meta>

      {/* ★ 第二条路：不依赖那张图、也不依赖那条链接的一条。
          微信个人二维码的有效期是**可选的**（1 天 / 7 天 / 永久），本人还随时能「重置」；
          而这张图和链接已经随 APK 发出去了，重置之后谁都改不回来。
          所以面板里必须并排摆一个还活着的人工入口 —— 搜号加人。 */}
      <View style={styles.idBox}>
        <Meta tone="ink3" style={styles.idLead}>
          扫不出来？在微信里搜这个号，长按可复制
        </Meta>
        <Body selectable style={styles.idValue}>
          {WECHAT_ID}
        </Body>
      </View>

      <View style={styles.foot}>
        <Button
          label={sharing ? '正在打开分享…' : '分享二维码到微信'}
          loading={sharing}
          onPress={() => void onShare()}
        />
        <Meta tone="ink4" style={styles.shareHint}>
          分享后在微信里长按这张图，选「识别图中二维码」
        </Meta>
        {onDone ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={doneLabel}
            onPress={onDone}
            style={styles.later}>
            <Meta tone="ink3">{doneLabel}</Meta>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

export interface AddWechatSheetProps {
  visible: boolean;
  onClose: () => void;
}

/** 独立面板。用在普通页面里（我的页 / 权益页 / 支持者页）。 */
export function AddWechatSheet({ visible, onClose }: AddWechatSheetProps) {
  return (
    <SheetModal visible={visible} onClose={onClose}>
      <AddWechatBody onDone={onClose} />
    </SheetModal>
  );
}

const useStyles = makeStyles((Palette) => ({
  head: { paddingHorizontal: Space.lg, paddingTop: Space.sm, alignItems: 'center' },
  title: { textAlign: 'center' },
  sub: { marginTop: Space.xs, textAlign: 'center' },

  /* 白底板：见文件头，这块颜色不参与换肤 */
  plate: {
    marginTop: Space.md,
    alignSelf: 'center',
    padding: Space.md,
    borderRadius: Radius.card,
    backgroundColor: Palette.pure,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Palette.line3,
  },
  platePressed: { opacity: 0.9 },
  qr: { width: QR_SIZE, height: QR_SIZE },

  name: { marginTop: Space.sm, alignSelf: 'center' },
  hint: { marginTop: Space.xs, textAlign: 'center' },

  /* 微信号那一块：见文件头，这是二维码和链接之外唯一还活着的入口 */
  idBox: {
    marginTop: Space.md,
    marginHorizontal: Space.lg,
    paddingVertical: Space.sm,
    paddingHorizontal: Space.md,
    borderRadius: Radius.card,
    backgroundColor: Palette.inset,
    alignItems: 'center',
  },
  idLead: { textAlign: 'center' },
  idValue: { fontSize: 17, letterSpacing: 0.4, marginTop: Space.xs },

  foot: { marginTop: Space.lg, paddingHorizontal: Space.lg },
  shareHint: { marginTop: Space.sm, textAlign: 'center', lineHeight: 18 },
  later: { alignSelf: 'center', marginTop: Space.md, paddingVertical: Space.xs },

  /* 放大态：整块可点，点哪儿都返回 */
  zoomWrap: {
    alignItems: 'center',
    paddingHorizontal: Space.lg,
    paddingTop: Space.sm,
    paddingBottom: Space.lg,
  },
  zoomName: { marginBottom: Space.md },
  zoomPlate: {
    padding: Space.lg,
    borderRadius: Radius.sheet,
    backgroundColor: Palette.pure,
  },
  zoomQr: { width: QR_ZOOM_SIZE, height: QR_ZOOM_SIZE },
  zoomHint: { marginTop: Space.md, textAlign: 'center' },
}));
