// =========================================================================
// SimboloClase.tsx
// El SÍMBOLO de la clase de una alarma: el icono que la identifica de un
// vistazo, antes de leer nada.
//
// Son los mismos cinco iconos que usa el editor de alarmas en su columna ID
// (`ALARM_CLASSES` en AlarmsEditor.tsx), a propósito: la «12» con su octógono
// rojo tiene que verse igual donde se configura y donde salta. Aquí se llega
// a ellos por la SEVERIDAD, que es lo que guarda cada evento (1 = Critical …
// 5 = Information).
//
// Vive aparte porque lo pintan dos sitios —el widget de alarmas del lienzo y
// la pantalla de Alarmas— y dos copias de una tabla de iconos se separan a
// la primera clase que se añada.
// =========================================================================
import {
  AlertOctagonIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  WrenchIcon,
  InfoIcon,
  BellIcon,
  type LucideIcon,
} from 'lucide-react';
import {
  CLASE_DE_SEVERIDAD,
  colorSimbolo,
} from '../../services/alarmasRuntimeApi';

const ICONO_DE_SEVERIDAD: Record<number, LucideIcon> = {
  1: AlertOctagonIcon,
  2: AlertCircleIcon,
  3: AlertTriangleIcon,
  4: WrenchIcon,
  5: InfoIcon,
};

export function SimboloClase({
  severidad,
  tam = 14,
}: {
  severidad: number;
  /** Lado del icono, en píxeles. */
  tam?: number;
}) {
  const Icono = ICONO_DE_SEVERIDAD[severidad] ?? BellIcon;
  const clase = CLASE_DE_SEVERIDAD[severidad] ?? 'Alarma';
  return (
    <span
      role="img"
      aria-label={clase}
      title={clase}
      className={colorSimbolo(severidad)}
      style={{ display: 'inline-flex', flexShrink: 0 }}
    >
      <Icono aria-hidden="true" style={{ width: tam, height: tam }} />
    </span>
  );
}
