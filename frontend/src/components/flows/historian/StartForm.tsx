import { FlowNodeData } from '../types';
import { GrupoAccionForm } from './GrupoAccionForm';

interface Props {
  config: Record<string, any>;
  historianNodes: FlowNodeData[];
  onChange: (patch: Record<string, any>) => void;
}

/** Nodo Start -> `POST /historian/{grupo_id}/start`. */
export function StartForm(props: Props) {
  return <GrupoAccionForm accion="start" {...props} />;
}
