import { describe, expect, it } from "vitest";
import { buildNewaveFlowPayload, parseNewaveKeywords, validateNewaveActivation } from "../lib/newave-config";

describe("configuração Newave", () => {
  it("normaliza palavras-chave separadas por linha ou vírgula", () => {
    expect(parseNewaveKeywords("newave\n crédito, newave ")).toEqual(["newave", "crédito"]);
  });

  it("exige ao menos um gatilho somente ao ativar", () => {
    const base={active:true,ctwa:false,sessionIds:[],keywords:[]};
    expect(validateNewaveActivation(base)).toContain("gatilho");
    expect(validateNewaveActivation({...base,ctwa:true})).toBeNull();
    expect(validateNewaveActivation({...base,active:false})).toBeNull();
  });
  it("mapeia todos os controles para o contrato da API",()=>{
    expect(buildNewaveFlowPayload({active:true,ctwa:true,sessionIds:["session-1"],keywords:["newave"]})).toEqual({
      nome:"Fluxo Newave",ativo:true,ctwa:true,sessoes:["session-1"],palavras_chave:["newave"]
    });
  });
});
