// src/components/hmi/custom/motor/MotorHidraulico.tsx
import { CogIcon } from 'lucide-react';
import type { CustomWidgetDef } from '../types';

export const motorHidraulico: CustomWidgetDef = {
  kind: 'custom:motor-hidraulico',
  label: 'Motor Hidráulico',
  category: 'Equipos',
  icon: CogIcon,
  defaultWidth: 180,
  defaultHeight: 220,
  render: ({ style, label, widget }) => {
    // Usa el label si hay variable vinculada; si no, el name del widget
    const tag = label && label !== widget.text ? label : (widget.name || 'MT-001');
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          height: '100%',
          containerType: 'inline-size',
          padding: '5%',
          position: 'relative',
          boxSizing: 'border-box',
          justifyContent: 'center'
        }}
      >
        <div
          data-ui="label"
          style={{
            fontWeight: style.bold ? 'bold' : 500,
            fontSize: '10cqi',
            fontFamily: 'Arial, sans-serif',
            marginBottom: '5%',
            color: style.color,
            textAlign: 'center',
            width: 'max-content',
            whiteSpace: 'nowrap'
          }}
        >
          {tag}
        </div>

        <div style={{ width: '100%', maxWidth: 300, position: 'relative' }}>
          <svg
            viewBox="0 0 160 100"
            style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
          >
            <rect
              x="110"
              y="45"
              width="28"
              height="10"
              stroke={style.color}
              fill="white"
              strokeWidth="1"
            />

            <circle
              cx="80"
              cy="50"
              r="30"
              stroke={style.color}
              fill="white"
              strokeWidth="1.5"
            />

            <polygon points="70,20 90,20 80,40" fill={style.color} />
            <polygon points="70,80 90,80 80,60" fill={style.color} />

            <line x1="80" y1="0" x2="80" y2="20" stroke={style.color} strokeWidth="1" />
            <line x1="80" y1="80" x2="80" y2="100" stroke={style.color} strokeWidth="1" />

            <g>
              <path
                d="M 35,35 A 40 40 0 0 0 35,65"
                fill="none"
                stroke={style.color}
                strokeWidth="1.5"
              />

              <polygon
                points="0,-4 8,0 0,4"
                fill={style.color}
                transform="translate(35,35) rotate(-45)"
              />

              <polygon
                points="0,-4 8,0 0,4"
                fill={style.color}
                transform="translate(35,65) rotate(45)"
              />
            </g>
          </svg>
        </div>
      </div>
    );
  }
};