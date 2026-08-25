export type QualificationStatus="em_andamento"|"pausado"|"concluido";
export type QualificationAction="pausar"|"retomar"|"reiniciar";

export function availableQualificationActions(status:QualificationStatus):QualificationAction[] {
  if(status==="em_andamento")return ["pausar","reiniciar"];
  if(status==="pausado")return ["retomar","reiniciar"];
  return ["reiniciar"];
}
