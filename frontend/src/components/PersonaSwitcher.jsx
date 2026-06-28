import { DEFAULT_PERSONA_ID, PERSONA_OPTIONS, resolvePersonaOption } from '../personas';

export default function PersonaSwitcher({ personaState, onChange, disabled = false }) {
  const personas = personaState?.personas?.length ? personaState.personas : PERSONA_OPTIONS;
  const activeId = personaState?.active_persona_id || DEFAULT_PERSONA_ID;

  return (
    <div className="persona-switcher" role="group" aria-label="角色模式">
      {personas.map((persona) => {
        const isActive = persona.id === activeId;
        const displayPersona = resolvePersonaOption(persona.id);
        return (
          <button
            key={persona.id}
            type="button"
            className={`persona-option ${isActive ? 'active' : ''}`}
            onClick={() => onChange(persona.id)}
            disabled={disabled || isActive}
            title={`${persona.title}：${persona.tagline}`}
          >
            <span className="persona-title">{displayPersona.title}</span>
          </button>
        );
      })}
    </div>
  );
}
