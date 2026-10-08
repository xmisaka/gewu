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
import { Modal, Pressable, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, type ThemeKey } from '@/constants/theme';
import { AFDIAN_URL } from '@/constants/site';
import { SUPPORTER_FEATURES, type SupporterFeature } from '@/lib/entitlement';
import { makeStyles } from '@/lib/theme';
import { Button } from '../ui/controls';
import { Body, Heading, Meta } from '../ui/typography';

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

/** 两项说明：价格与「已有码怎么办」。两者都是「不用问我」就能回答的问题 */
const DISCLOSURES: readonly { title: string; body: string }[] = [
  { title: '一次买断 ¥28', body: '含 v2 内全部支持者功能，不订阅、不自动续费。' },
  { title: '已有激活码？', body: '直接粘贴，本机校验即可解锁 —— 不联网、不绑设备。' },
];

export function SupporterGateSheet({ visible, feature, themeIntent, onClose }: SupporterGateSheetProps) {
  const styles = useStyles();
  const router = useRouter();
  const copy = SUPPORTER_FEATURES[feature];

  /* 商品页还没上架时（AFDIAN_URL 为空）不显示主按钮：
     一个点开是空白的「去支持」比暂时没有入口更伤信任 */
  const hasStore = AFDIAN_URL.length > 0;

  /** 去激活页；带意图时用 params 传，激活成功后那边就地生效 */
  const goActivate = () => {
    onClose();
    if (themeIntent) {
      router.push({ pathname: '/supporter', params: { theme: themeIntent } });
    } else {
      router.push('/supporter');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <View style={styles.head}>
          <Heading>{copy.sheetTitle}</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
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
          {hasStore ? <Button label="去爱发电支持" onPress={goActivate} /> : null}
          <Button label="我已有激活码" tone="secondary" style={styles.secondary} onPress={goActivate} />
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.later}>
            <Meta tone="ink3">稍后再说</Meta>
          </Pressable>
        </View>
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
     免得「¥28」和「已有码」看起来像主次关系 */
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

  foot: { paddingHorizontal: GUTTER, paddingTop: Space.xl },
  secondary: { marginTop: Space.sm },
  later: { alignSelf: 'center', marginTop: Space.md, padding: Space.xs },
}));
