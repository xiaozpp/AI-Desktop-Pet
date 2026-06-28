export const DEFAULT_PERSONA_ID = 'companion';

export const PERSONA_OPTIONS = [
  {
    id: 'creator',
    title: '创作者',
    tagline: '代码 / 产品',
  },
  {
    id: 'companion',
    title: '陪伴',
    tagline: '情绪 / 日常',
  },
  {
    id: 'coach',
    title: '守护',
    tagline: '专注 / 习惯',
  },
  {
    id: 'private',
    title: '私人',
    tagline: '长期 / 熟悉',
  },
];

export function resolvePersonaOption(personaId) {
  return (
    PERSONA_OPTIONS.find((persona) => persona.id === personaId)
    || PERSONA_OPTIONS.find((persona) => persona.id === DEFAULT_PERSONA_ID)
    || PERSONA_OPTIONS[0]
  );
}
