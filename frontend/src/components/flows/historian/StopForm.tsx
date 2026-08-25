import { FlowNodeData } from '../types';
import { GrupoAccionForm } from './GrupoAccionForm';

interface Props {
  config: Record<string, any>;
  historianNodes: FlowNodeData[];
  onChange: (patch: Record<string, any>) => void;
}

/** Nodo Stop -> `POST /historian/{grupo_id}/stop`. */
export function StopForm(props: Props) {
  return <GrupoAccionForm accion="stop" {...props} />;
}
