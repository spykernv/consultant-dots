/** `flawedAnswer`: a typical rushed candidate answer, to try the challenge mode. */
export type SampleCase = { id: string; title: string; domain: string; text: string; flawedAnswer: string };

export const SAMPLE_CASES: SampleCase[] = [
  {
    id: "data-platform",
    title: "Reporting multi-filiales",
    domain: "Data Platform",
    text: `Un groupe industriel européen (1,2 Md€ de chiffre d'affaires) est organisé en trois filiales : France, Allemagne et Espagne. Chaque filiale a son propre ERP et ses propres outils de reporting. Les définitions des KPIs (marge, taux de service, OTD) diffèrent d'une filiale à l'autre.

Chaque mois, l'équipe contrôle de gestion groupe consolide les chiffres à la main dans Excel : cela prend environ 10 jours et les chiffres sont régulièrement contestés en comité de direction. Il est aussi très difficile de croiser les données commerciales et industrielles des filiales.

La DG souhaite disposer d'une vision consolidée et fiable de la performance et envisage de « créer une data platform groupe ». La filiale allemande indique que certaines données RH et clients ne peuvent pas quitter l'Allemagne. La DSI groupe est une petite équipe de 15 personnes.`,
    flawedAnswer: `Je propose de créer un data lake groupe sur Azure pour centraliser toutes les données des trois filiales. On connecte les trois ERP par API en temps réel, puis on construit des dashboards Power BI pour la DG avec tous les KPIs. Ensuite, on pourra ajouter de l'IA pour prédire les ventes. La DSI pilote le projet et on déploie sur les trois filiales en même temps d'ici 6 mois.`,
  },
  {
    id: "genai-assurance",
    title: "Conseillers & GenAI",
    domain: "GenAI / IA",
    text: `Un assureur IARD compte 800 conseillers en centre de relation client. Le temps moyen de traitement d'un appel est de 9 minutes, dont près d'un tiers passé à chercher l'information dans une base documentaire de 15 000 pages (conditions générales, procédures, notes internes), souvent obsolète ou contradictoire.

La satisfaction client baisse et le turnover des conseillers est élevé (25 % par an), ce qui rallonge les formations.

Le comité exécutif veut « mettre de la GenAI » dans la relation client d'ici 6 mois et a déjà reçu plusieurs propositions d'éditeurs, dont un chatbot autonome qui répondrait directement aux clients. Les réponses données aux clients peuvent avoir des conséquences contractuelles et les données clients sont soumises au RGPD.`,
    flawedAnswer: `Je recommande de déployer le chatbot autonome proposé par l'éditeur sur le site et l'application, branché sur toute la base documentaire, pour répondre directement aux clients. Cela réduira fortement le temps de traitement et permettra de baisser le nombre de conseillers. On peut tout lancer d'ici 6 mois avec un grand modèle du marché.`,
  },
  {
    id: "cloud-industriel",
    title: "Sites industriels & cloud",
    domain: "Cloud / SI",
    text: `Un industriel de l'agroalimentaire exploite 5 sites de production en France et environ 120 applications, dont une partie en legacy (développements spécifiques des années 2000). Tout est hébergé dans un datacenter on-premise dont le contrat d'infogérance arrive à échéance dans 18 mois.

Les coûts d'infrastructure sont élevés, la maintenance est complexe et chaque déploiement prend plusieurs semaines. Les sites n'utilisent pas tous les mêmes versions des applications de production (MES). Certaines applications pilotent des lignes de production et ne tolèrent aucune interruption.

Le DSI souhaite « tout migrer dans le cloud » avant la fin du contrat.`,
    flawedAnswer: `Comme le souhaite le DSI, on migre les 120 applications dans le cloud public en lift and shift pour sortir du datacenter avant la fin du contrat. On fait tout en une seule vague sur 12 mois, avec un intégrateur, puis on modernisera les applications plus tard.`,
  },
];
