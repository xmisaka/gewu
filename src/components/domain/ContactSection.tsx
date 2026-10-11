/**
 * 格物 · 联系我
 *
 * 格物没有账号、没有客服后台、也没有商店评论区 —— 想找作者只有这一条路，
 * 所以这张二维码必须真的**能用**，不能只是摆着看：
 * 可以点开放大给别人扫，也可以分享出去在微信里长按识别。
 *
 * ★ 二维码底板固定用 Palette.pure，不跟主题走。
 *   扫码靠的是「深色模块压浅色底」这个对比度，跟 App 换了哪套配色无关；
 *   深色主题下如果底板跟着变暗，二维码就直接扫不出来了。
 *   同理，图片本身的白底是烘进 PNG 的，不是样式 —— 不归皮肤管。
 */

import { Image } from 'expo-image';
import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, View } from 'react-native';

import { Palette, Radius, Space } from '@/constants/theme';
import { WECHAT_NAME } from '@/constants/site';
import { WECHAT_QR, shareWechatQr } from '@/lib/contact';
import { Button } from '../ui/controls';
import { Card, Gutter, SectionCard } from '../ui/layout';
import { Body, Heading, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

/** 卡内二维码边长；再小就开始挑扫码器的对焦能力了 */
const QR_SIZE = 200;
/** 放大态的边长。屏幕最窄的机型也放得下（264 + 两边留白 < 360） */
const QR_ZOOM_SIZE = 264;

/** 默认开场白。「我的」页用它；激活页那边不传（标题已说明来意，二维码就在下面） */
const DEFAULT_LEAD =
  '格物没有账号、没有客服后台，也没有评论区。有问题、有建议，或者想获取激活码，都可以加我微信。';

export interface ContactSectionProps {
  /** 卡片标题，默认「联系我」 */
  title?: string;
  /**
   * 开场白。传 `null` 就整段不渲染。
   * ★ 激活页那边传 `null`：那张卡的标题已经说明来意（加我微信获取激活码），
   *   二维码就在正下方，再铺一段「扫下面这张码加我…」纯属啰嗦。
   */
  lead?: string | null;
}

export function ContactSection({ title = '联系我', lead = DEFAULT_LEAD }: ContactSectionProps = {}) {
  const styles = useStyles();
  const [zoomed, setZoomed] = useState(false);
  const [sharing, setSharing] = useState(false);

  const onShare = async () => {
    setSharing(true);
    try {
      const ok = await shareWechatQr();
      /* 没有分享面板是设备能力问题，不是错误：给出不需要分享的两条替代路径 */
      if (!ok) {
        Alert.alert(
          '这台设备没有分享面板',
          '可以点开二维码用另一台手机扫；或者直接截屏，再在微信里从相册选这张图识别。',
        );
      }
    } catch (err) {
      /* 原始错误多半是英文技术细节（比如 expo-sharing 的 scheme 报错），直接给用户看没有意义。
         打到控制台留线索，界面上只说接下来该怎么做。 */
      console.warn('[gewu] 分享二维码失败：', err);
      Alert.alert('分享失败', '重试一次；还不行就点开二维码截屏，在微信里从相册选这张图识别。');
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <SectionCard title={title}>
        <Gutter>
          <Card>
            {lead ? (
              <Body tone="ink2" style={styles.lead}>
                {lead}
              </Body>
            ) : null}

            {/* ★ 名字写在白底板**外面**。
                底板恒为 `Palette.pure`（固定白，见文件头），名字要是也放进底板，
                就只能用**写死的**深色值 —— 因为 `ink` 在深色主题下会变成近白，
                白字压白底**直接看不见**，而且不报错。
                放在外面就能用主题感知的 ink，也省得为它新增一个固定色令牌
                （令牌表是 7 套 × 27 个，官网那边有断言钉着，不能随便加）。 */}
            <Heading style={[styles.name, !lead && styles.nameFirst]}>{WECHAT_NAME}</Heading>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="放大微信二维码"
              onPress={() => setZoomed(true)}
              android_ripple={{ color: Palette.ripple }}
              style={({ pressed }) => [styles.plate, pressed && styles.platePressed]}>
              <Image source={WECHAT_QR} style={styles.qr} contentFit="contain" />
            </Pressable>

            <Meta tone="ink4" style={styles.hint}>
              扫二维码加我，点一下可放大
            </Meta>

            <Button
              tone="secondary"
              icon="share-outline"
              label={sharing ? '正在打开分享…' : '分享二维码'}
              loading={sharing}
              onPress={() => void onShare()}
              style={styles.shareBtn}
            />
          </Card>
        </Gutter>
      </SectionCard>

      <Modal
        visible={zoomed}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setZoomed(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭二维码"
          onPress={() => setZoomed(false)}
          style={styles.backdrop}>
          <Heading color={Palette.pure}>{WECHAT_NAME}</Heading>
          <View style={styles.zoomPlate}>
            <Image source={WECHAT_QR} style={styles.zoomQr} contentFit="contain" />
          </View>
          <Meta color={Palette.pure} style={styles.zoomHint}>
            用另一台手机的微信扫一扫 · 点任意处关闭
          </Meta>
        </Pressable>
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------ 样式 */

const useStyles = makeStyles((Palette) => ({
  lead: { lineHeight: 21 },
  name: { marginTop: Space.md, alignSelf: 'center' },
  nameFirst: { marginTop: 0 },
  hint: { marginTop: Space.sm, lineHeight: 18, textAlign: 'center' },
  shareBtn: { marginTop: Space.md },

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

  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.lg,
    padding: Space.xxl,
    backgroundColor: Palette.scrim,
  },
  zoomPlate: {
    padding: Space.lg,
    borderRadius: Radius.sheet,
    backgroundColor: Palette.pure,
  },
  zoomQr: { width: QR_ZOOM_SIZE, height: QR_ZOOM_SIZE },
  zoomHint: { textAlign: 'center' },
}));
