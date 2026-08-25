import {describe,expect,it} from "vitest";
import {buildLeadFilterQuery,type LeadFilters} from "../lib/lead-filters";
import {availableQualificationActions} from "../lib/qualification-controls";

const empty:LeadFilters={status:"",unidade_id:"",categoria_id:"",parceiro_id:"",busca:"",estrelas:"",fila_humana:"",faturamento:"",resultado:"",investimento:"",formulario:""};

describe("filtros e controles da qualificação",()=>{
  it.each([
    ["faturamento","Até R$ 10 mil"],["resultado","E3_ENCERRAMENTO"],["investimento","NAO"],["formulario","pausado"]
  ] as const)("serializa o filtro %s sem incluir campos vazios",(field,value)=>{
    const query=buildLeadFilterQuery({...empty,[field]:value});
    const params=new URLSearchParams(query);
    expect(params.get(field)).toBe(value);expect([...params.keys()]).toEqual([field]);
  });
  it("oferece somente ações coerentes com o estado",()=>{
    expect(availableQualificationActions("em_andamento")).toEqual(["pausar","reiniciar"]);
    expect(availableQualificationActions("pausado")).toEqual(["retomar","reiniciar"]);
    expect(availableQualificationActions("concluido")).toEqual(["reiniciar"]);
  });
});
