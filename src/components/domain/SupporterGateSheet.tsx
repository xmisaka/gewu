/**
 * 格物 · 支持者功能门控浮层
 *
 * 免费档点到支持者功能时弹的就是它（方案页 05 屏）。
 *
 * 文案顺序是刻意的：**第一句先讲能得到什么，第二句紧接着说明免费档没被拿掉什么**。
 * 没有商店的评分系统兜底时，用户对「你是不是在逼我付费」的敏感度反而更高，
 * 这句话就是防线 —— 所以它不能省，也不能挪到下面。
 *
 * 浮层只负责「告知 + 给两条路」，不自己弹激活界面：
 * 「我已有激活码」交给 /supporter 那一页，码的输入与校验只有一处实现。
 */

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Modal, Pressable, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, type ThemeKey } from '@/constants/theme';
import { AFDIAN_ITEM_URL, LICENSE_HOWTO } from '@/constants/site';
import { SUPPORTER_FEATURES, type SupporterFeature } from '@/lib/entitlement';
import { makeStyles } from '@/lib/theme';
import { Button } from '../ui/controls';
import { Body, Heading, Meta } from '../ui/typography';
import { AddWechatBody } from './AddWechatSheet';

export interface SupporterGateSheetProps {
  visible: boolean;
  /** 被挡下的功能，决定正文文案 */
  feature: SupporterFeature;
  /**
   * 用户**本来想做的那件事**（目前只有「想换到某套皮肤」）。
   * 带上它跳激活页，激活成功后就地生效 —— 否则用户付完钱回来还得再点一次，
   * 那一次多余的点击会让人觉得「是不是没激活成功」。
   */
  themeIntent?: ThemeKey;
  onClose: () => void;
}

/** 两项说明：价格与「码从哪来」。两者都是「不用问我」就能回答的问题 */
const DISCLOSURES: readonly { title: string; body: string }[] = [
  { title: '一次买断 ¥36', body: '含 v2 内全部支持者功能，不订阅、不自动续费。' },
  {
    title: '激活码怎么来？',
    body: `${LICENSE_HOWTO}。已经有码的直接粘贴，本机校验、不联网。`,
  },
];

export function SupporterGateSheet({ visible, feature, themeIntent, onClose }: SupporterGateSheetProps) {
  const styles = useStyles();
  const router = useRouter();
  const copy = SUPPORTER_FEATURES[feature];

  /** 「加我微信」是**换掉整个面板内容**，不是叠第二个面板 —— 理由见 render 里那段注释 */
  const [showWechat, setShowWechat] = useState(false);

  /**
   * 关掉浮层，顺带把「加我微信」那一屏收回去。
   *
   * ★ 不用 `useEffect` 监听 `visible` 来复位：那是在 effect 里同步 setState，
   *   会触发级联渲染（`react-hooks/set-state-in-effect` 直接报错），
   *   而且 React 官方给的判据也在这里 —— 复位不是「同步外部系统」。
   *   这个浮层在多数页面是常显的（`visible` 由外层守卫决定），
   *   所以复位只能挂在**关闭这一个动作**上：凡是走得掉的出口都从这里过。
   */
  const close = () => {
    setShowWechat(false);
    onClose();
  };

  /**
   * 去爱发电下单 —— 购买的主路径（2026-10-15 恢复）。
   *
   * ★ 打开失败不弹错误：地址已经写在按钮上，极少数打不开浏览器的机型上，
   *   用户自己会走下面那条「加我微信」（两者是刻意并列的备用关系）。
   */
  const openAfdian = () => {
    close();
    void Linking.openURL(AFDIAN_ITEM_URL).catch(() => undefined);
  };

  /** 去激活页；带意图时用 params 传，激活成功后那边就地生效 */
  const goActivate = () => {
    close();
    if (themeIntent) {
      router.push({ pathname: '/supporter', params: { theme: themeIntent } });
    } else {
      router.push('/supporter');
    }
  };

  /**
   * 去看完整的权益说明。
   *
   * ★ 这是整件事里最关键的一步：浮层是「你被挡住了」的语境，
   *   用户在这里接收到的全是限制。给一个「先看看全部权益」的正向出口，
   *   把这个负面瞬间接到那一页上 —— 否则权益永远只以「不许」的样子出现。
   */
  const goBenefits = () => {
    close();
    router.push('/pro');
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        {/* ★★ 加微信是**换掉整个面板内容**，不是再叠一个 Modal。
            这个文件头上已经记着「两个 Modal 叠在一起在安卓上会互相抢返回键」
            （`mine.tsx` 的 onLockedPick 也是为同一个原因先关选择器再弹门控）——
            RN 的 Modal 在 Android 上是一个独立的 Dialog 窗口，套两层不可靠，
            而且它坏起来是「第二个面板根本不出现」，不报错。 */}
        {showWechat ? (
          <AddWechatBody doneLabel="返回" onDone={() => setShowWechat(false)} />
        ) : (
          <>
            <View style={styles.head}>
              <Heading>{copy.sheetTitle}</Heading>
              <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={close} hitSlop={10}>
                <Ionicons name="close" size={20} color={Palette.ink3} />
              </Pressable>
            </View>

            <View style={styles.body}>
              <Body tone="ink2" style={styles.desc}>
                {copy.sheetBody}
              </Body>

              {DISCLOSURES.map((item, index) => (
                <View key={item.title} style={styles.disclosure}>
                  <View style={styles.badge}>
                    <Meta color={Palette.brand} style={styles.badgeText}>
                      {index + 1}
                    </Meta>
                  </View>
                  <Body tone="ink2" style={styles.disclosureText}>
                    <Body style={styles.disclosureTitle}>{item.title}</Body>
                    {` ${item.body}`}
                  </Body>
                </View>
              ))}
            </View>

            <View style={styles.foot}>
              {/* 摆主按钮之前先给一个「先看看」的出口。被挡下的这一刻用户是带着情绪的，
                  硬要他当场付款只会触发那套「你是不是在逼我付费」的警觉；
                  让他去看完整的对比，反而是更有效的说服 */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="查看支持者的全部权益"
                onPress={goBenefits}
                style={styles.benefits}>
                <Meta color={Palette.brand}>看全部权益（免费档 vs 支持者档）→</Meta>
              </Pressable>

              {/* ★ 2026-10-15：主按钮改回爱发电商品页（创作者认证已通过，下单自动发码）。
                  ★ 微信**并列**在下面，是备用：爱发电打不开、或想直接找我的人走它。
                    两者是「主 + 备」而非二选一 —— 微信这条路不依赖任何可能为空的地址。 */}
              <Button label="去爱发电支持" onPress={openAfdian} />
              <Button
                label="加我微信"
                tone="secondary"
                style={styles.secondary}
                onPress={() => setShowWechat(true)}
              />
              <Pressable accessibilityRole="button" onPress={goActivate} style={styles.later}>
                <Meta tone="ink3">我已有激活码</Meta>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={close} style={styles.laterInline}>
                <Meta tone="ink3">稍后再说</Meta>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((Palette) => ({
  backdrop: { flex: 1, backgroundColor: Palette.scrim },
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingBottom: Space.xxl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.line,
    alignSelf: 'center',
    marginTop: Space.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.md,
  },
  body: { paddingHorizontal: GUTTER },
  desc: { lineHeight: 22 },

  disclosure: { flexDirection: 'row', alignItems: 'flex-start', gap: Space.sm, marginTop: Space.md },
  /* 序号做成一个小品牌色药丸：两条说明同等重要，用序号而不是图标，
     免得「¥36」和「已有码」看起来像主次关系 */
  badge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Palette.brandBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  badgeText: { fontSize: 11, lineHeight: 15, fontWeight: '600' },
  disclosureText: { flex: 1, lineHeight: 21 },
  disclosureTitle: { fontWeight: '600' },

  foot: { paddingHorizontal: GUTTER, paddingTop: Space.lg },
  /* 它排在主按钮之上，是个「了解更多」而不是「立刻买」，
     所以做成文字链、居中，不抢主按钮的分量 */
  benefits: {
    alignSelf: 'center',
    paddingVertical: Space.xs,
    paddingHorizontal: Space.sm,
    marginBottom: Space.md,
  },
  storeNote: { lineHeight: 20 },
  secondary: { marginTop: Space.sm },
  later: { alignSelf: 'center', marginTop: Space.md, padding: Space.xs },
  /* 两条文字链挨着排：「我已有激活码」与「稍后再说」是同一层级的次级出口，
     上间距收窄，免得看起来像两组不同分量的东西 */
  laterInline: { alignSelf: 'center', marginTop: 0, padding: Space.xs },
}));
