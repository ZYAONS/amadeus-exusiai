export type Emotion = 'neutral' | 'joy' | 'smile1' | 'smile2' | 'shy' | 'anger' | 'sadness' | 'unhappy'

// 关键词打分，不额外调一次模型（参考项目是第二次请求做情感分类，这里省掉一次往返，
// 好处是离线模式也有表情）。顺序有意义：命中次数多的赢，平手时靠前的赢。
const RULES: [Emotion, RegExp][] = [
  ['anger', /(烦|气死|生气|可恶|该死的|滚开|闭嘴|别吵|吵死|凶|揍|开火|子弹|靶子|うるさい|ムカ|撃て|弾)/],
  ['unhappy', /(唉|算了|无聊|没意思|不行|不想|可惜|麻烦|糟糕|好累|累了|つまらない|めんどくさ|だるい|はぁ)/],
  ['sadness', /(难过|伤心|抱歉|对不起|离开|失去|再见|告别|死了|眼泪|想哭|寂寞|一个人|ごめん|悲し|寂し|さよなら|涙)/],
  ['shy', /(喜欢你|夸|谢谢|脸红|害羞|别这样|不好意思|抱|亲|ありがとう|照れ|恥ずかし|好き)/],
  ['joy', /(哈哈哈|哈哈|开心|高兴|好耶|太棒|不错|走起|出发|派对|苹果|冰淇淋|好玩|有趣|嬉し|楽しい|やった|最高|わーい)/],
  ['smile2', /(交给我|放心|没问题|小事|当然|包在我身上|搞定|包送|一定|任せて|大丈夫|もちろん|問題ない)/],
]

export function classifyEmotion(text: string): Emotion {
  let best: Emotion = 'neutral'
  let bestScore = 0
  for (const [emotion, re] of RULES) {
    const hits = text.match(new RegExp(re.source, 'g'))?.length ?? 0
    if (hits > bestScore) {
      bestScore = hits
      best = emotion
    }
  }
  if (bestScore === 0 && /[!！]/.test(text)) return 'smile1'
  return best
}

export const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: '平静',
  joy: '兴奋',
  smile1: '微笑',
  smile2: '从容',
  shy: '不好意思',
  anger: '上火',
  sadness: '低落',
  unhappy: '兴致不高',
}
