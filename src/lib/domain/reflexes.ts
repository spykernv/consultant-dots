import type { ReflexId } from "@/lib/schemas/common";

type Reflex = {
  name: string;
  flag: string;
  titleFr: string;
  flagFr: string;
};

export const REFLEXES: Record<ReflexId, Reflex> = {
  E1: {
    name: "Solution before diagnosis",
    flag: "You are proposing architecture before establishing the requirements.",
    titleFr: "Solution avant diagnostic",
    flagFr: "Vous proposez une architecture avant d'avoir établi les besoins.",
  },
  E2: {
    name: "Technology presented as the business objective",
    flag: "Cloud migration is a means, not the business objective.",
    titleFr: "Technologie présentée comme objectif",
    flagFr: "La migration cloud est un moyen, pas l'objectif business.",
  },
  E3: {
    name: "Unjustified technical choice",
    flag: "Why API rather than batch, ETL or another integration mechanism?",
    titleFr: "Choix technique non justifié",
    flagFr: "Pourquoi une API plutôt qu'un batch, un ETL ou un autre mécanisme d'intégration ?",
  },
  E4: {
    name: "Ignoring stakeholders",
    flag: "Who owns this decision and who will actually use the solution?",
    titleFr: "Parties prenantes oubliées",
    flagFr: "Qui porte cette décision et qui utilisera réellement la solution ?",
  },
  E5: {
    name: "Ignoring adoption",
    flag: "How will the target users change their way of working?",
    titleFr: "Adoption ignorée",
    flagFr: "Comment les utilisateurs cibles vont-ils changer leur façon de travailler ?",
  },
  E6: {
    name: "No measurement",
    flag: "What baseline and KPI would demonstrate that the transformation worked?",
    titleFr: "Pas de mesure",
    flagFr: "Quelle baseline et quel KPI prouveraient que la transformation a fonctionné ?",
  },
  E7: {
    name: "Quick win disconnected from the long-term target",
    flag: "Does this pilot create reusable foundations or technical debt?",
    titleFr: "Quick win déconnecté de la cible",
    flagFr: "Ce pilote crée-t-il des fondations réutilisables ou de la dette technique ?",
  },
  E8: {
    name: "Centralization assumed by default",
    flag: "Does the business requirement actually require physical centralization?",
    titleFr: "Centralisation par défaut",
    flagFr: "Le besoin métier exige-t-il vraiment une centralisation physique ?",
  },
  E9: {
    name: "AI use case selected without risk analysis",
    flag: "What happens if the model gives an incorrect answer?",
    titleFr: "Cas d'usage IA sans analyse de risque",
    flagFr: "Que se passe-t-il si le modèle donne une réponse fausse ?",
  },
  E10: {
    name: "Cloud assumed for every application",
    flag: "Should this workload actually migrate?",
    titleFr: "Cloud pour toutes les applications",
    flagFr: "Ce workload doit-il vraiment migrer ?",
  },
};
