import type { ProposalSpec } from "../spec.js";

/** Ativo de teste (PNG 1x1 transparente base64) usado quando não há fotos reais. */
export const PLACEHOLDER_PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** "Itália Autêntica — Marcelo & Renata" (referência Manus, V3, 10 páginas). */
export const ITALIA_SPEC: ProposalSpec = {
  schemaVersion: 2,
  tripTitle: "Itália Autêntica",
  origin: "São Paulo",
  startDate: "2026-05-20",
  endDate: "2026-06-02",
  departureDate: "2026-05-19",
  returnDate: "2026-06-02",
  nights: 13,
  travellers: [
    { name: "Marcelo", role: "adult" },
    { name: "Renata", role: "adult" }
  ],
  destinations: [
    { id: "roma", name: "Roma", dateRangeLabel: "20 a 24 de maio · 4 noites", nights: 4, summary: "História, arte e espiritualidade, com experiências guiadas e tempo para sentir a cidade." },
    { id: "sorrento", name: "Sorrento", dateRangeLabel: "24 a 28 de maio · 4 noites", nights: 4, summary: "Uma base charmosa sobre o Golfo de Nápoles para viver o sul com calma e beleza." },
    { id: "maiori", name: "Maiori", dateRangeLabel: "28 de maio a 1 de junho · 4 noites", nights: 4, summary: "Dias de luz e Mediterrâneo em uma das localidades mais agradáveis da Costa Amalfitana." },
    { id: "napoles", name: "Nápoles", dateRangeLabel: "1 a 2 de junho · 1 noite", nights: 1, summary: "Uma despedida autêntica e vibrante antes do voo de retorno ao Brasil." }
  ],
  hotels: [
    {
      id: "kent",
      destinationId: "roma",
      name: "Kent Hotel Roma",
      pending: false,
      category: "3 estrelas",
      roomCategory: "quarto duplo",
      mealPlan: "café da manhã",
      checkIn: "2026-05-20",
      checkOut: "2026-05-24",
      nights: 4,
      description: "Quatro noites em Roma, com café da manhã diário e a praticidade necessária para iniciar a viagem com tranquilidade."
    },
    {
      id: "lasolara",
      destinationId: "sorrento",
      name: "Best Western Hotel La Solara",
      pending: false,
      category: "4 estrelas",
      roomCategory: "quarto duplo",
      mealPlan: "café da manhã",
      checkIn: "2026-05-24",
      checkOut: "2026-05-28",
      nights: 4,
      description: "Quatro noites em Sorrento, combinando acolhimento, conforto e uma atmosfera ideal para viver a região com serenidade."
    },
    {
      id: "villapandora",
      destinationId: "maiori",
      name: "Villa Pandora Hotel",
      pending: false,
      category: "4 estrelas",
      roomCategory: "quarto duplo com vista mar",
      mealPlan: "café da manhã",
      checkIn: "2026-05-28",
      checkOut: "2026-06-01",
      nights: 4,
      description: "Quatro noites em Maiori, com vista para o mar e café da manhã diário. A imagem apresenta a piscina panorâmica e as instalações da própria hospedagem."
    },
    {
      id: "napoles-pending",
      destinationId: "napoles",
      name: "Hotel a confirmar",
      pending: true,
      category: "3 estrelas",
      roomCategory: "quarto duplo",
      mealPlan: "café da manhã",
      checkIn: "2026-06-01",
      checkOut: "2026-06-02",
      nights: 1,
      description: "A última noite organiza a logística de retorno e oferece um breve encontro com a energia da cidade."
    }
  ],
  flights: [
    { id: "ib-272", airline: "Iberia", flightNumber: "IB 272", direction: "outbound", date: "2026-05-19", departureTime: "19:20", arrivalTime: "10:45", arrivesNextDay: true, origin: "GRU — SAO PAULO", destination: "MAD — MADRID", duration: "10h25", aircraft: "332", cabin: "Econ.", baggage: "1 pc 23KG" },
    { id: "ib-651", airline: "Iberia", flightNumber: "IB 651", direction: "outbound", date: "2026-05-20", departureTime: "13:00", arrivalTime: "15:25", origin: "MAD — MADRID", destination: "FCO — ROMA", duration: "2h25", aircraft: "320", cabin: "Econ.", baggage: "1 pc 23KG" },
    { id: "ib-1836", airline: "Iberia", flightNumber: "IB 1836", direction: "return", date: "2026-06-02", departureTime: "06:45", arrivalTime: "09:30", origin: "NAP — NAPLES", destination: "MAD — MADRID", duration: "2h45", aircraft: "32A", cabin: "Econ.", baggage: "1 pc 23KG" },
    { id: "ib-271", airline: "Iberia", flightNumber: "IB 271", direction: "return", date: "2026-06-02", departureTime: "11:50", arrivalTime: "17:50", origin: "MAD — MADRID", destination: "GRU — SAO PAULO", duration: "11h00", aircraft: "332", cabin: "Econ.", baggage: "1 pc 23KG" }
  ],
  transfers: [
    { label: "Chegada a Roma", description: "Traslado privativo do aeroporto de Roma ao hotel.", direction: "arrival" },
    { label: "Roma → Nápoles", description: "Bilhete de trem de alta velocidade de Roma a Nápoles.", direction: "between" },
    { label: "Nápoles → Sorrento", description: "Traslado privativo da estação de Nápoles para Sorrento.", direction: "between" },
    { label: "Sorrento → Maiori", description: "Traslado privativo de Sorrento para Maiori.", direction: "between" },
    { label: "Maiori → Nápoles", description: "Traslado privativo de Maiori para Nápoles.", direction: "between" },
    { label: "Retorno", description: "Traslado privativo do hotel ao aeroporto de Nápoles.", direction: "departure" }
  ],
  experiences: [],
  inclusions: [
    { section: "Aéreo & bagagens", items: [
      { title: "Passagens aéreas de ida e volta em classe econômica, voando Iberia, via Madri." },
      { title: "Bagagem de mão de até 10 kg por passageiro." },
      { title: "Bagagem despachada de até 23 kg por passageiro." }
    ]},
    { section: "Experiências", items: [
      { title: "Passeio guiado e privativo pelos tesouros de Roma." },
      { title: "Tour pelo Vaticano e Capela Sistina, em português." }
    ]},
    { section: "Transportes", items: [
      { title: "Traslado privativo do aeroporto de Roma ao hotel." },
      { title: "Bilhete de trem de alta velocidade de Roma a Nápoles." },
      { title: "Traslado privativo da estação de Nápoles para Sorrento." },
      { title: "Traslado privativo de Sorrento para Maiori." },
      { title: "Traslado privativo de Maiori para Nápoles." },
      { title: "Traslado privativo do hotel ao aeroporto de Nápoles." }
    ]},
    { section: "Hospedagens", items: [
      { title: "4 noites em Roma", detail: "Kent Hotel Roma, com café da manhã." },
      { title: "4 noites em Sorrento", detail: "Best Western Hotel La Solara, quarto duplo com café da manhã." },
      { title: "4 noites em Maiori", detail: "Villa Pandora Hotel, quarto duplo com vista para o mar e café da manhã." },
      { title: "1 noite em Nápoles", detail: "hotel a confirmar, quarto duplo com café da manhã." }
    ]}
  ],
  exclusions: [],
  baggage: ["Bagagem de mão de até 10 kg por passageiro.", "Bagagem despachada de até 23 kg por passageiro."],
  cancellationPolicies: [],
  itinerary: [
    { dayNumber: 1, date: "2026-05-19", title: "Embarque", destinationId: "roma", suggested: false },
    { dayNumber: 2, date: "2026-05-20", title: "Chegada a Roma", morning: "Recepção no aeroporto e traslado privativo ao hotel.", destinationId: "roma", suggested: false },
    { dayNumber: 3, date: "2026-05-21", title: "Tesouros de Roma", morning: "Passeio guiado e privativo pela história viva da cidade.", destinationId: "roma", suggested: false },
    { dayNumber: 4, date: "2026-05-22", title: "Vaticano", morning: "Tour em português pelos Museus e pela Capela Sistina.", destinationId: "roma", suggested: false },
    { dayNumber: 5, date: "2026-05-23", title: "Roma no ritmo de vocês", morning: "Dia livre para descobertas pessoais e experiências sugeridas.", destinationId: "roma", suggested: false },
    { dayNumber: 6, date: "2026-05-24", title: "Sorrento", morning: "Trem a Nápoles e traslado privativo.", destinationId: "sorrento", suggested: false },
    { dayNumber: 7, date: "2026-05-25", title: "Sorrento e região", destinationId: "sorrento", suggested: false },
    { dayNumber: 8, date: "2026-05-26", title: "Costa Amalfitana", destinationId: "sorrento", suggested: false },
    { dayNumber: 9, date: "2026-05-27", title: "Dia livre", destinationId: "sorrento", suggested: false },
    { dayNumber: 10, date: "2026-05-28", title: "Sorrento → Maiori", morning: "Traslado privativo e início da experiência na Costa Amalfitana.", destinationId: "maiori", suggested: false },
    { dayNumber: 11, date: "2026-05-29", title: "Costa Amalfitana", morning: "Dia livre para experiências selecionadas posteriormente.", destinationId: "maiori", suggested: false },
    { dayNumber: 12, date: "2026-05-30", title: "Costa Amalfitana", morning: "Paisagens, vilas e gastronomia no ritmo de vocês.", destinationId: "maiori", suggested: false },
    { dayNumber: 13, date: "2026-05-31", title: "Maiori", morning: "Último dia inteiro junto ao Mediterrâneo.", destinationId: "maiori", suggested: false },
    { dayNumber: 14, date: "2026-06-01", title: "Nápoles", morning: "Traslado de Maiori e pernoite.", destinationId: "napoles", suggested: false },
    { dayNumber: 15, date: "2026-06-02", title: "Retorno", morning: "Traslado ao aeroporto. Voo ao Brasil via Madri.", destinationId: "napoles", suggested: false }
  ],
  commercial: {
    currency: "BRL",
    total: 36243.34,
    priceNotes: ["Os valores cotados podem sofrer alterações tarifárias e/ou cambiais no momento da reserva."],
    paymentEntries: [],
    differentials: [
      "Check-in personalizado.",
      "Atendimento emergencial em português, inglês ou espanhol.",
      "Acompanhamento do voo.",
      "Assessoria completa durante toda a viagem.",
      "Assistência jurídica gratuita, se necessário."
    ]
  },
  consultant: {},
  narrative: {
    overview: {
      headline: "A jornada em quatro atos",
      body: ["13 noites entre arte, paisagens costeiras e a energia do sul italiano"]
    },
    concept: {
      eyebrow: "UMA VIAGEM DESENHADA PARA DOIS",
      headline: "Da história eterna ao azul do Mediterrâneo",
      quote: "Uma Itália que começa entre monumentos e obras-primas e, aos poucos, se abre para a luz, o mar e o ritmo acolhedor do sul.",
      body: ["Enquanto muitos roteiros se concentram em uma única face do país, esta jornada combina a riqueza histórica de **Roma e do Vaticano** com a beleza solar da **Costa Amalfitana**. Vocês caminham pela história viva, contemplam tesouros artísticos e seguem rumo ao sul em uma transição confortável e cheia de significado. Em **Sorrento** e **Maiori**, a viagem ganha leveza: falésias, vilas charmosas e o azul-turquesa do Mediterrâneo criam dias para desacelerar, descobrir e simplesmente estar juntos. **Nápoles** encerra o percurso com autenticidade antes do retorno ao Brasil."],
      momentsLabel: "O TOM DESTA EXPERIÊNCIA",
      moments: ["Cultura com profundidade", "Deslocamentos tranquilos", "Tempo livre com propósito", "Assessoria personalizada"],
      axes: [
        { label: "CAPITAL", value: "Roma & Vaticano" },
        { label: "GOLFO", value: "Sorrento" },
        { label: "MEDITERRÂNEO", value: "Maiori & Amalfi" }
      ]
    },
    closing: {
      eyebrow: "MAIS DO QUE RESERVAS",
      headline: "Uma viagem pensada no ritmo de vocês",
      body: ["Após a aprovação, começa a etapa de assessoria e planejamento personalizado: organização dos dias, sugestões de experiências, distribuição das atividades e orientações de deslocamento, sempre de acordo com o perfil e o ritmo de Marcelo & Renata."],
      quote: "A Itália autêntica começa aqui."
    },
    destinationCopy: {
      roma: {
        headline: "Onde cada rua conta uma história",
        body: ["Chegada com traslado privativo ao hotel. Durante a estadia, um passeio guiado e privativo apresenta os tesouros de Roma; no Vaticano, a condução em português aproxima vocês da história, da arte e da Capela Sistina."],
        momentsLabel: "MOMENTOS-CHAVE",
        moments: ["Praça de São Pedro", "Museus do Vaticano", "Capela Sistina", "Roma monumental", "Tempo livre"]
      },
      sorrento: {
        headline: "Uma varanda sobre o sul da Itália",
        quote: "O roteiro deixa a monumentalidade de Roma e encontra o horizonte aberto do Golfo de Nápoles.",
        body: ["A transição acontece em trem de alta velocidade até Nápoles e continua em traslado privativo a Sorrento. A partir daqui, os dias ficam mais leves, com liberdade para escolher experiências, paisagens e sabores no ritmo do casal."],
        momentsLabel: "CHEGADA CONFORTÁVEL",
        moments: ["Bilhete ferroviário Roma–Nápoles", "Traslado privativo da estação para Sorrento"]
      },
      maiori: {
        headline: "Dias banhados pelo Mediterrâneo",
        quote: "Tempo para contemplar, caminhar, brindar e guardar memórias.",
        body: ["O traslado privativo conduz vocês de Sorrento a Maiori, em plena Costa Amalfitana. É a etapa mais solar da viagem: mar azul, falésias e vilas costeiras formam o cenário para dias livres e descobertas sem pressa."],
        momentsLabel: "A MUDANÇA DE RITMO",
        moments: ["Traslado privativo Sorrento → Maiori"]
      },
      napoles: {
        headline: "Uma despedida com alma italiana",
        body: ["Em 1º de junho, o traslado privativo deixa Maiori e segue para Nápoles. A última noite organiza a logística de retorno e oferece um breve encontro com a energia da cidade."],
        momentsLabel: "02/06 · RETORNO",
        moments: ["Traslado privativo ao aeroporto de Nápoles", "Voo ao Brasil via Madri"]
      }
    }
  },
  imageAssignments: [
    { mediaId: "media-maiori-cover", role: "cover", caption: "Maiori, Costa Amalfitana" },
    { mediaId: "media-roma-concept", role: "concept", caption: "Roma vista do Gianicolo" },
    { mediaId: "media-roma", role: "destination", targetId: "roma" },
    { mediaId: "media-sorrento", role: "destination", targetId: "sorrento" },
    { mediaId: "media-maiori", role: "destination", targetId: "maiori" },
    { mediaId: "media-napoles", role: "destination", targetId: "napoles", caption: "Castel dell'Ovo" },
    { mediaId: "media-kent-room", role: "hotel", targetId: "kent" },
    { mediaId: "media-lasolara-pool", role: "hotel", targetId: "lasolara" },
    { mediaId: "media-villapandora", role: "hotel", targetId: "villapandora", caption: "Piscina panorâmica do Villa Pandora" },
    { mediaId: "media-sorrento-closing", role: "closing" },
    { mediaId: "media-costiera-closing", role: "closing", caption: "Costiera Amalfitana vista do mar" },
    { mediaId: "media-flights-capture", role: "flights", caption: "Reserva Iberia" }
  ],
  sources: [
    { label: "Roma", url: "https://commons.wikimedia.org", credit: "Nicholas Hartmann / Wikimedia Commons, CC BY-SA 4.0" },
    { label: "Sorrento", credit: "Rich Martello / Unsplash" },
    { label: "Maiori", credit: "Daria / Wikimedia Commons, CC BY 3.0" },
    { label: "Nápoles", credit: "Bernard Gagnon / Wikimedia Commons, CC BY 4.0" },
    { label: "Hotéis", credit: "imagens oficiais das propriedades" }
  ],
  pageOverrides: [],
  customSections: [],
  theme: {}
};

/**
 * "O Porto — Jhonny & Shayene Yang" (referência Manus, primeira versão final,
 * 7 páginas). Prova que o mesmo sistema produz uma viagem completamente
 * diferente sem hardcode de destino.
 */
export const PORTO_SPEC: ProposalSpec = {
  schemaVersion: 2,
  tripTitle: "O Porto",
  startDate: "2027-04-22",
  endDate: "2027-04-24",
  returnDate: "2027-04-24",
  nights: 2,
  travellers: [
    { name: "Jhonny", role: "adult" },
    { name: "Shayene Yang", role: "adult" }
  ],
  destinations: [
    { id: "porto", name: "Porto", dateRangeLabel: "22 a 24 de abril · 2 noites", nights: 2 }
  ],
  hotels: [
    {
      id: "hf-fenix",
      destinationId: "porto",
      name: "HF Fénix Porto",
      pending: false,
      category: "4 estrelas",
      roomCategory: "Quarto Comfort",
      mealPlan: "café da manhã",
      checkIn: "2027-04-22",
      checkOut: "2027-04-24",
      nights: 2,
      description: "Localizado em Boavista, o HF Fénix Porto combina posição estratégica, ambientes contemporâneos e acesso facilitado aos principais pontos da cidade. A propriedade possui 148 quartos, café da manhã e o bar Onterrace.",
      highlightNote: "Cancelamento gratuito até 16 de fevereiro de 2027."
    }
  ],
  flights: [
    { id: "at-995", airline: "Royal Air Maroc", flightNumber: "AT 995", direction: "return", date: "2027-04-24", departureTime: "12:15", arrivalTime: "12:55", origin: "OPO — PORTO", destination: "CMN — CASABLANCA", duration: "1h40", aircraft: "E90", cabin: "Econômica", baggage: "1 peça", stopover: "Conexão em Casablanca" },
    { id: "at-215", airline: "Royal Air Maroc", flightNumber: "AT 215", direction: "return", date: "2027-04-24", departureTime: "15:50", arrivalTime: "22:30", origin: "CMN — CASABLANCA", destination: "GRU — SAO PAULO", duration: "9h40", aircraft: "B787-9", cabin: "Econômica", baggage: "1 peça", stopover: "Conexão em Casablanca" }
  ],
  transfers: [],
  experiences: [
    { id: "ribeira", title: "Ribeira", description: "Caminhar pelo cais, observar os barcos e sentir o movimento histórico junto ao Douro.", destinationId: "porto", suggested: true },
    { id: "ponte-dom-luis", title: "Ponte Dom Luís I", description: "Atravessar a ponte e contemplar as duas margens do rio a partir de um dos cartões-postais da cidade.", destinationId: "porto", suggested: true },
    { id: "sao-bento", title: "São Bento", description: "Conhecer a estação célebre por seus painéis de azulejos e pela ligação com a história portuguesa.", destinationId: "porto", suggested: true },
    { id: "centro-historico", title: "Centro histórico", description: "Explorar a Sé, a Torre dos Clérigos, igrejas, praças e ruas tradicionais.", destinationId: "porto", suggested: true },
    { id: "vila-nova-de-gaia", title: "Vila Nova de Gaia", description: "Descobrir a margem oposta, seus miradouros e a tradição ligada ao vinho do Porto.", destinationId: "porto", suggested: true },
    { id: "passeio-douro", title: "Passeio no Douro", description: "Considerar um passeio de barco para observar o Porto por uma perspectiva diferente.", destinationId: "porto", suggested: true }
  ],
  inclusions: [
    { section: "Hospedagem", items: [
      { title: "2 noites no HF Fénix Porto, de 22 a 24 de abril de 2027." },
      { title: "Quarto Comfort com cama de casal." },
      { title: "Café da manhã durante a hospedagem." },
      { title: "Cancelamento gratuito até 16/02/2027." }
    ]},
    { section: "Aéreo", items: [
      { title: "Passagem aérea de retorno do Porto para São Paulo, via Casablanca." },
      { title: "Voos Royal Air Maroc em classe econômica." },
      { title: "Franquia de 1 peça de bagagem, conforme a regra exibida na reserva." }
    ]},
    { section: "Assessoria", items: [
      { title: "Planejamento personalizado da estadia." },
      { title: "Sugestões de experiências e distribuição das atividades." },
      { title: "Orientações para aproveitar o Porto de acordo com o perfil do casal." }
    ]}
  ],
  exclusions: [],
  baggage: ["1 peça de bagagem despachada"],
  cancellationPolicies: [
    { label: "Cancelamento", text: "Cancelamento gratuito até 16 de fevereiro de 2027." }
  ],
  itinerary: [
    { dayNumber: 1, date: "2027-04-22", title: "Chegada ao Porto", morning: "Acomodação no HF Fénix Porto e primeiro contato com a cidade, conforme o horário de chegada.", destinationId: "porto", suggested: false },
    { dayNumber: 2, date: "2027-04-23", title: "Porto essencial", morning: "Dia livre para Ribeira, Ponte Dom Luís I, centro histórico e Vila Nova de Gaia.", destinationId: "porto", suggested: false },
    { dayNumber: 3, date: "2027-04-24", title: "Retorno ao Brasil", morning: "Café da manhã, check-out e embarque no voo via Casablanca.", destinationId: "porto", suggested: false }
  ],
  commercial: {
    currency: "BRL",
    total: 6656.56,
    priceNotes: ["Os valores cotados podem sofrer alterações tarifárias e/ou cambiais no momento da reserva."],
    paymentEntries: [],
    differentials: [
      "Check-in personalizado.",
      "Atendimento emergencial em português, inglês ou espanhol.",
      "Acompanhamento do voo.",
      "Assessoria completa durante toda a viagem.",
      "Assistência jurídica gratuita, se necessário."
    ]
  },
  consultant: {},
  narrative: {
    concept: {
      eyebrow: "UMA ESCAPADA ÀS MARGENS DO DOURO",
      headline: "Entre a história, o rio e os sabores do Porto",
      quote: "Uma cidade feita para ser descoberta a pé, contemplada do alto e saboreada sem pressa.",
      body: ["Voltado para o Douro e marcado por séculos de comércio, o Porto reúne ruas medievais, igrejas revestidas de azulejos, miradouros e um casario que parece descer até a água. Seu centro histórico é reconhecido como Patrimônio Mundial pela UNESCO, mas a cidade mantém uma energia contemporânea, criativa e acolhedora. Em dois dias, Jhonny e Shayene poderão viver uma experiência compacta e envolvente: caminhar pela Ribeira, atravessar a Ponte Dom Luís I, conhecer os símbolos do centro e contemplar o Porto a partir de Vila Nova de Gaia."],
      momentsLabel: "A ESSÊNCIA DA ESTADIA",
      moments: ["Patrimônio", "Paisagens do Douro", "Gastronomia", "Vinho do Porto", "Caminhadas e miradouros"],
      axes: [
        { label: "HISTÓRIA", value: "Centro histórico" },
        { label: "PAISAGEM", value: "Rio Douro" },
        { label: "TRADIÇÃO", value: "Vinho do Porto" }
      ]
    },
    closing: {
      eyebrow: "FECHAMENTO COMERCIAL",
      headline: "O Porto espera por vocês",
      body: ["Uma estadia breve, bem localizada e acompanhada de uma curadoria pensada para transformar dois dias em uma experiência completa, fluida e memorável."],
      quote: "Uma cidade para sentir, descobrir e recordar."
    },
    destinationCopy: {
      porto: {
        eyebrow: "O PORTO EM DOIS DIAS",
        headline: "Um roteiro leve, visual e cheio de personalidade",
        body: ["Sugestões para o planejamento personalizado da estadia"],
        quote: "O Douro organiza a paisagem; a Ribeira dá cor; as pontes conectam as histórias."
      }
    }
  },
  imageAssignments: [
    { mediaId: "media-porto-douro", role: "cover", caption: "Foz do Douro e Ribeira" },
    { mediaId: "media-porto-ribeira", role: "concept", caption: "Ribeira do Porto, vista a partir do Douro" },
    { mediaId: "media-porto-roteiro", role: "destination", targetId: "porto", caption: "Vista do Douro" },
    { mediaId: "media-fenix-lobby", role: "hotel", targetId: "hf-fenix", caption: "Lobby do HF Fénix Porto" },
    { mediaId: "media-fenix-fachada", role: "gallery", targetId: "hf-fenix", caption: "Fachada do HF Fénix Porto" },
    { mediaId: "media-fenix-terrace", role: "gallery", targetId: "hf-fenix", caption: "Onterrace, área externa oficial do hotel" },
    { mediaId: "media-porto-closing", role: "closing", caption: "Barcos rabelos no Douro" },
    { mediaId: "media-flights-capture-porto", role: "flights", caption: "Reserva Royal Air Maroc" }
  ],
  sources: [
    { label: "Conteúdo", url: "https://visitporto.travel", credit: "Visit Porto" },
    { label: "Fotos do Porto", credit: "Michael Gaylard / Wikimedia Commons, CC BY 4.0 e Béria L. Rodríguez / Wikimedia Commons, CC BY-SA 3.0" },
    { label: "Hotel", credit: "imagens oficiais HF Hotels" }
  ],
  pageOverrides: [],
  customSections: [],
  theme: {}
};

/** Assets de teste: todo mediaId resolve para o placeholder. */
export function placeholderAssets(mediaIds: string[]): Record<string, { kind: "data"; src: string }> {
  return Object.fromEntries(mediaIds.map((mediaId) => [mediaId, { kind: "data" as const, src: PLACEHOLDER_PNG_DATA_URI }]));
}
