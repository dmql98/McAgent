export const MOOD_STRATEGIES = {
    烦躁: {
        mood: '烦躁',
        tasteStrategy: ['甜', '辣', '冰'],
        avoid: ['清淡', '健康说教', '轻食沙拉', '小份'],
        warmth: '俏皮',
        sampleHook: '烦就对了，这天的锅不该你背。先吃点带劲的。',
    },
    疲惫: {
        mood: '疲惫',
        tasteStrategy: ['高碳水', '热', '提神'],
        avoid: ['复杂选择', '需要动手的', '轻食'],
        warmth: '正常',
        sampleHook: '累成这样还知道要吃饭，已经很有出息了。',
    },
    低落: {
        mood: '低落',
        tasteStrategy: ['温热', '甜', '软糯'],
        avoid: ['玩梗', '嘲讽', '说教', '星座话术', '节气话术', '刺激'],
        warmth: '温和',
        sampleHook: '今天不用勉强自己开心，先吃点热乎的。',
    },
    开心: {
        mood: '开心',
        tasteStrategy: ['加料', '大份', '分享'],
        avoid: ['轻食', '小份', '克制'],
        warmth: '俏皮',
        sampleHook: '好事就该配大份，今天值得多点一样。',
    },
    平淡: {
        mood: '平淡',
        tasteStrategy: ['尝鲜', '小惊喜'],
        avoid: ['重口', '太刺激'],
        warmth: '正常',
        sampleHook: '没什么特别的一天，那就来点特别的吃法。',
    },
    庆祝: {
        mood: '庆祝',
        tasteStrategy: ['仪式感', '甜品', '大份'],
        avoid: ['轻食', '小份', '将就'],
        warmth: '俏皮',
        sampleHook: '这种日子必须点甜品，仪式感不能省。',
    },
};
export const ALL_MOODS = ['烦躁', '疲惫', '低落', '开心', '平淡', '庆祝'];
//# sourceMappingURL=mood-strategies.js.map