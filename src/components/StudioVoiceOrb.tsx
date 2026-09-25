import React, { useId } from 'react'

export type StudioVoiceState = 'IDLE' | 'CONNECTING' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR_MIC'

export interface StudioVoiceOrbProps {
  voiceState: StudioVoiceState
  isMentor?: boolean
  isMobile?: boolean
  onClick?: () => void
}

export const StudioVoiceOrb: React.FC<StudioVoiceOrbProps> = ({
  voiceState,
  isMentor = false,
  isMobile = false,
  onClick,
}) => {
  const uid = useId().replace(/:/g, '')

  // Paleta de Cores Dinâmicas para Aurora e LEDs de acordo com o Estado
  const colors = {
    IDLE: {
      primary: '#38bdf8', // ciano celeste
      secondary: '#818cf8', // violeta suave
      ringGlow: 'rgba(56, 189, 248, 0.45)',
      backdropGlow: 'rgba(56, 189, 248, 0.16)',
      backdropSecondary: 'rgba(129, 140, 248, 0.10)',
      led: '#38bdf8',
      ledGlow: 'rgba(56, 189, 248, 0.7)',
    },
    CONNECTING: {
      primary: '#38bdf8',
      secondary: '#60a5fa',
      ringGlow: 'rgba(56, 189, 248, 0.65)',
      backdropGlow: 'rgba(56, 189, 248, 0.28)',
      backdropSecondary: 'rgba(96, 165, 250, 0.20)',
      led: '#fef08a',
      ledGlow: 'rgba(254, 240, 138, 0.8)',
    },
    LISTENING: {
      primary: '#34d399', // verde esmeralda neon
      secondary: '#06b6d4', // ciano elétrico
      ringGlow: 'rgba(52, 211, 153, 0.7)',
      backdropGlow: 'rgba(52, 211, 153, 0.28)',
      backdropSecondary: 'rgba(6, 182, 212, 0.20)',
      led: '#10b981',
      ledGlow: 'rgba(52, 211, 153, 0.9)',
    },
    THINKING: {
      primary: '#c084fc', // violeta neon
      secondary: '#818cf8',
      ringGlow: 'rgba(192, 132, 252, 0.65)',
      backdropGlow: 'rgba(192, 132, 252, 0.26)',
      backdropSecondary: 'rgba(129, 140, 248, 0.18)',
      led: '#a855f7',
      ledGlow: 'rgba(192, 132, 252, 0.85)',
    },
    SPEAKING: {
      primary: isMentor ? '#fbbf24' : '#60a5fa', // ouro se mentor, azul/ciano se professor
      secondary: isMentor ? '#f59e0b' : '#818cf8',
      ringGlow: isMentor ? 'rgba(251, 191, 36, 0.7)' : 'rgba(96, 165, 250, 0.7)',
      backdropGlow: isMentor ? 'rgba(251, 191, 36, 0.28)' : 'rgba(96, 165, 250, 0.26)',
      backdropSecondary: isMentor ? 'rgba(245, 158, 11, 0.20)' : 'rgba(129, 140, 248, 0.18)',
      led: isMentor ? '#f59e0b' : '#38bdf8',
      ledGlow: isMentor ? 'rgba(251, 191, 36, 0.9)' : 'rgba(56, 189, 248, 0.9)',
    },
    ERROR_MIC: {
      primary: '#f87171',
      secondary: '#ef4444',
      ringGlow: 'rgba(248, 113, 113, 0.5)',
      backdropGlow: 'rgba(248, 113, 113, 0.20)',
      backdropSecondary: 'rgba(239, 68, 68, 0.12)',
      led: '#ef4444',
      ledGlow: 'rgba(248, 113, 113, 0.8)',
    },
  }[voiceState]

  const isSpinning = voiceState === 'CONNECTING'
  const isListening = voiceState === 'LISTENING'
  const isSpeaking = voiceState === 'SPEAKING'
  const isIdle = voiceState === 'IDLE'

  // Proporções dinâmicas
  const orbSize = isMobile ? 165 : 185
  const micWidth = isMobile ? 104 : 116
  const micHeight = isMobile ? 132 : 146

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick?.()
        }
      }}
      title={
        isSpeaking
          ? 'Clique para interromper o agente (Barge-in)'
          : isIdle
          ? 'Clique para iniciar a conversa por voz'
          : 'Sessão de voz em andamento'
      }
      aria-label={
        isSpeaking
          ? 'Interromper fala do agente'
          : isIdle
          ? 'Iniciar conversa por voz com o Professor IA'
          : 'Microfone de voz do Professor IA'
      }
      style={{
        position: 'relative',
        width: orbSize,
        height: orbSize,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: isSpinning ? 'wait' : 'pointer',
        userSelect: 'none',
        outline: 'none',
        transition: 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
      className="studio-voice-orb-interactive"
    >
      <style>{`
        @keyframes aurora-breathe-${uid} {
          0%, 100% {
            opacity: 0.82;
            filter: drop-shadow(0 0 10px ${colors.ringGlow}) drop-shadow(0 0 24px ${colors.backdropGlow});
            transform: scale(0.99);
          }
          50% {
            opacity: 1;
            filter: drop-shadow(0 0 20px ${colors.ringGlow}) drop-shadow(0 0 38px ${colors.backdropGlow});
            transform: scale(1.02);
          }
        }

        @keyframes aurora-spin-${uid} {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes magnetic-ripple-1-${uid} {
          0% {
            transform: scale(0.85);
            opacity: 0.85;
          }
          100% {
            transform: scale(1.48);
            opacity: 0;
          }
        }

        @keyframes magnetic-ripple-2-${uid} {
          0% {
            transform: scale(0.85);
            opacity: 0.85;
          }
          100% {
            transform: scale(1.48);
            opacity: 0;
          }
        }

        @keyframes soundwave-equalizer-odd-${uid} {
          0%, 100% { transform: scaleY(0.75); }
          50% { transform: scaleY(1.35); }
        }

        @keyframes soundwave-equalizer-even-${uid} {
          0%, 100% { transform: scaleY(1.3); }
          50% { transform: scaleY(0.7); }
        }

        .studio-voice-orb-interactive:hover {
          transform: scale(1.04);
        }
        .studio-voice-orb-interactive:active {
          transform: scale(0.98);
        }

        @media (prefers-reduced-motion: reduce) {
          .studio-voice-orb-animated {
            animation: none !important;
          }
        }
      `}</style>

      {/* 1. Backdrop Aurora Glow (Luz Difusa de Fundo) */}
      <div
        style={{
          position: 'absolute',
          width: orbSize * 0.85,
          height: orbSize * 0.85,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${colors.backdropGlow} 0%, ${colors.backdropSecondary} 52%, transparent 75%)`,
          filter: 'blur(12px)',
          pointerEvents: 'none',
          transition: 'background 0.5s ease',
        }}
      />

      {/* 2. Ondas Magnéticas Concêntricas (Captação e Propagação de Voz em Tempo Real) */}
      {(isListening || isSpeaking || isSpinning) && (
        <>
          <div
            className="studio-voice-orb-animated"
            style={{
              position: 'absolute',
              inset: 8,
              borderRadius: '50%',
              border: `1.8px solid ${colors.primary}`,
              pointerEvents: 'none',
              animation: `magnetic-ripple-1-${uid} ${isListening ? '1.5s' : '2.0s'} cubic-bezier(0.1, 0.6, 0.4, 1) infinite`,
            }}
          />
          <div
            className="studio-voice-orb-animated"
            style={{
              position: 'absolute',
              inset: 8,
              borderRadius: '50%',
              border: `1.8px solid ${colors.secondary}`,
              pointerEvents: 'none',
              animation: `magnetic-ripple-2-${uid} ${isListening ? '1.5s' : '2.0s'} cubic-bezier(0.1, 0.6, 0.4, 1) ${isListening ? '0.75s' : '1.0s'} infinite`,
            }}
          />
        </>
      )}

      {/* 3. Anel de Aurora e Ondas Sonoras Radiais (Estilo Equalizador Circular) */}
      <div
        className="studio-voice-orb-animated"
        style={{
          position: 'absolute',
          inset: -14,
          pointerEvents: 'none',
          animation: isSpinning
            ? `aurora-spin-${uid} 6s linear infinite`
            : isIdle
            ? `aurora-breathe-${uid} 4s ease-in-out infinite`
            : `aurora-breathe-${uid} 2.5s ease-in-out infinite`,
          transformOrigin: 'center center',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          width={orbSize + 28}
          height={orbSize + 28}
          viewBox="0 0 210 210"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id={`aurora-grad-${uid}`} x1="20" y1="20" x2="190" y2="190" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor={colors.primary} stopOpacity={0.95} />
              <stop offset="45%" stopColor={colors.secondary} stopOpacity={0.75} />
              <stop offset="85%" stopColor={colors.primary} stopOpacity={0.4} />
              <stop offset="100%" stopColor={colors.secondary} stopOpacity={0.15} />
            </linearGradient>

            <linearGradient id={`wave-grad-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="35%" stopColor={colors.primary} />
              <stop offset="100%" stopColor={colors.secondary} />
            </linearGradient>

            <filter id={`aurora-blur-${uid}`} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Anel Circular de Aurora Suave */}
          <circle
            cx="105"
            cy="100"
            r="76"
            stroke={`url(#aurora-grad-${uid})`}
            strokeWidth="2"
            filter={`url(#aurora-blur-${uid})`}
          />

          {/* Arco de Ondas Sonoras Radiais (11 barras de espectro sonoro no quadrante superior direito) */}
          <g filter={`url(#aurora-blur-${uid})`}>
            {/* Barra 1 */}
            <line
              x1="126"
              y1="30"
              x2="130"
              y2="16"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.2"
              strokeLinecap="round"
              style={{
                transformOrigin: '126px 30px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-odd-${uid} 0.8s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 2 */}
            <line
              x1="135"
              y1="34"
              x2="142"
              y2="18"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.2"
              strokeLinecap="round"
              style={{
                transformOrigin: '135px 34px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-even-${uid} 0.9s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 3 */}
            <line
              x1="144"
              y1="39"
              x2="154"
              y2="21"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.4"
              strokeLinecap="round"
              style={{
                transformOrigin: '144px 39px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-odd-${uid} 0.75s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 4 */}
            <line
              x1="152"
              y1="45"
              x2="166"
              y2="26"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.5"
              strokeLinecap="round"
              style={{
                transformOrigin: '152px 45px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-even-${uid} 0.85s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 5 */}
            <line
              x1="160"
              y1="52"
              x2="177"
              y2="33"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.6"
              strokeLinecap="round"
              style={{
                transformOrigin: '160px 52px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-odd-${uid} 0.7s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 6 (Ápice da Onda) */}
            <line
              x1="167"
              y1="61"
              x2="187"
              y2="43"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.8"
              strokeLinecap="round"
              style={{
                transformOrigin: '167px 61px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-even-${uid} 0.65s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 7 */}
            <line
              x1="172"
              y1="70"
              x2="194"
              y2="55"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.8"
              strokeLinecap="round"
              style={{
                transformOrigin: '172px 70px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-odd-${uid} 0.75s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 8 */}
            <line
              x1="176"
              y1="80"
              x2="197"
              y2="68"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.6"
              strokeLinecap="round"
              style={{
                transformOrigin: '176px 80px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-even-${uid} 0.8s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 9 */}
            <line
              x1="179"
              y1="91"
              x2="198"
              y2="82"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.4"
              strokeLinecap="round"
              style={{
                transformOrigin: '179px 91px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-odd-${uid} 0.9s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 10 */}
            <line
              x1="180"
              y1="102"
              x2="196"
              y2="97"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.2"
              strokeLinecap="round"
              style={{
                transformOrigin: '180px 102px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-even-${uid} 0.7s ease-in-out infinite` : undefined,
              }}
            />
            {/* Barra 11 */}
            <line
              x1="180"
              y1="113"
              x2="192"
              y2="111"
              stroke={`url(#wave-grad-${uid})`}
              strokeWidth="2.0"
              strokeLinecap="round"
              style={{
                transformOrigin: '180px 113px',
                animation: isListening || isSpeaking ? `soundwave-equalizer-odd-${uid} 0.85s ease-in-out infinite` : undefined,
              }}
            />
          </g>
        </svg>
      </div>

      {/* 4. Microfone de Estúdio Condensador de Alta Tecnologia (Sensação de Relevo e 3D) */}
      <svg
        width={micWidth}
        height={micHeight}
        viewBox="0 0 120 150"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          position: 'relative',
          zIndex: 2,
          filter: 'drop-shadow(0 10px 22px rgba(0, 0, 0, 0.55))',
        }}
      >
        <defs>
          {/* Gradiente da Grade Metálica Superior */}
          <linearGradient id={`grille-metal-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="20%" stopColor="#cbd5e1" />
            <stop offset="55%" stopColor="#64748b" />
            <stop offset="85%" stopColor="#334155" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>

          {/* Textura de Malha Cruzada Metálica de Estúdio */}
          <pattern id={`mic-mesh-${uid}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="none" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(15, 23, 42, 0.45)" strokeWidth="0.9" />
            <line x1="0" y1="0" x2="4" y2="0" stroke="rgba(255, 255, 255, 0.28)" strokeWidth="0.9" />
          </pattern>

          {/* Gradiente do Corpo Cilíndrico Acetinado */}
          <linearGradient id={`body-metal-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#bfdbfe" />
            <stop offset="18%" stopColor="#93c5fd" />
            <stop offset="52%" stopColor="#475569" />
            <stop offset="85%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>

          {/* Anel Central Cromado */}
          <linearGradient id={`chrome-ring-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="35%" stopColor="#94a3b8" />
            <stop offset="70%" stopColor="#cbd5e1" />
            <stop offset="100%" stopColor="#475569" />
          </linearGradient>

          {/* Suporte em U e Garfo */}
          <linearGradient id={`yoke-metal-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#94a3b8" />
            <stop offset="50%" stopColor="#64748b" />
            <stop offset="100%" stopColor="#334155" />
          </linearGradient>

          {/* Base Circular de Mesa com Iluminação Chanfrada */}
          <radialGradient id={`base-disc-${uid}`} cx="40%" cy="30%" r="65%">
            <stop offset="0%" stopColor="#94a3b8" />
            <stop offset="45%" stopColor="#475569" />
            <stop offset="85%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0f172a" />
          </radialGradient>
        </defs>

        {/* Sombra da Base no Plano Horizontal */}
        <ellipse cx="60" cy="144" rx="34" ry="5" fill="rgba(0,0,0,0.55)" />

        {/* 1. Base Circular de Mesa */}
        <ellipse cx="60" cy="140" rx="30" ry="6" fill={`url(#base-disc-${uid})`} />
        {/* Anel Chanfrado Superior com Reflexo */}
        <ellipse cx="60" cy="139" rx="27" ry="4.5" fill="none" stroke="rgba(255, 255, 255, 0.4)" strokeWidth="0.8" />

        {/* Haste Vertical de Apoio */}
        <rect x="57.5" y="116" width="5" height="24" rx="2" fill={`url(#body-metal-${uid})`} />
        <line x1="58.5" y1="116" x2="58.5" y2="140" stroke="rgba(255, 255, 255, 0.5)" strokeWidth="0.7" />

        {/* 2. Suporte Articulado em U (Yoke Mount) */}
        <path
          d="M 28 84 C 28 122, 92 122, 92 84"
          fill="none"
          stroke={`url(#yoke-metal-${uid})`}
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        {/* Filete de Brilho Superior no Garfo */}
        <path
          d="M 29 84 C 29 120, 91 120, 91 84"
          fill="none"
          stroke="rgba(255, 255, 255, 0.3)"
          strokeWidth="0.9"
          strokeLinecap="round"
        />

        {/* Parafusos/Knobs Laterais de Ajuste com Ranhura Texturizada */}
        {/* Esquerda */}
        <rect x="22" y="80" width="7" height="9" rx="2" fill="#64748b" stroke="#334155" strokeWidth="0.8" />
        <line x1="24" y1="81" x2="24" y2="88" stroke="rgba(255, 255, 255, 0.6)" strokeWidth="0.8" />
        {/* Direita */}
        <rect x="91" y="80" width="7" height="9" rx="2" fill="#475569" stroke="#1e293b" strokeWidth="0.8" />
        <line x1="93" y1="81" x2="93" y2="88" stroke="rgba(255, 255, 255, 0.4)" strokeWidth="0.8" />

        {/* 3. Corpo Cilíndrico Metálico do Microfone */}
        <path d="M 38 68 L 82 68 L 82 92 C 82 105, 38 105, 38 92 Z" fill={`url(#body-metal-${uid})`} />
        {/* Brilho Especular Lateral */}
        <path d="M 40 68 L 44 68 L 44 94 C 42 94, 40 93, 40 92 Z" fill="rgba(255, 255, 255, 0.25)" />

        {/* Botão Superior com LED Inteligente de Status */}
        <circle cx="60" cy="78" r="4.5" fill="#1e293b" stroke="rgba(255,255,255,0.25)" strokeWidth="0.8" />
        <circle
          cx="60"
          cy="78"
          r="3"
          fill={colors.led}
          style={{
            filter: `drop-shadow(0 0 5px ${colors.ledGlow})`,
            transition: 'fill 0.4s ease',
          }}
        />

        {/* Botão Inferior com Relevo */}
        <circle cx="60" cy="89" r="4.2" fill="#334155" stroke="rgba(255,255,255,0.2)" strokeWidth="0.8" />
        <circle cx="60" cy="89" r="3.2" fill={`url(#body-metal-${uid})`} />
        <circle cx="59.2" cy="88.2" r="1.1" fill="rgba(255,255,255,0.6)" />

        {/* Anel Cromado Central */}
        <rect x="37" y="65" width="46" height="4" rx="2" fill={`url(#chrome-ring-${uid})`} />
        <line x1="38" y1="66" x2="82" y2="66" stroke="#ffffff" strokeWidth="0.7" strokeLinecap="round" />

        {/* 4. Cápsula / Grade Metálica Superior com Malha e Relevo 3D */}
        <path d="M 38 65 L 38 36 C 38 18, 82 18, 82 36 L 82 65 Z" fill={`url(#grille-metal-${uid})`} />
        {/* Textura de Malha Sobreposta */}
        <path d="M 38 65 L 38 36 C 38 18, 82 18, 82 36 L 82 65 Z" fill={`url(#mic-mesh-${uid})`} />
        {/* Brilho Especular Curvo na Grelha */}
        <path d="M 41 64 L 41 36 C 41 24, 52 20, 60 19 C 50 20, 43 25, 43 36 L 43 64 Z" fill="rgba(255, 255, 255, 0.35)" />
        {/* Contorno Cromado com Reflexo */}
        <path d="M 38 65 L 38 36 C 38 18, 82 18, 82 36 L 82 65" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="1.2" />
      </svg>
    </div>
  )
}

export default StudioVoiceOrb
