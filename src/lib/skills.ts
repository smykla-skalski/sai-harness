export interface SkillChoice {
  name: string;
  description: string;
  id?: string;
}

export function skillQuery(draft: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(draft);
  return match?.[1].toLowerCase() ?? null;
}

export function matchingSkills(skills: SkillChoice[], draft: string): SkillChoice[] {
  const query = skillQuery(draft);
  if (query === null) return [];
  return skills.filter((skill) => skill.name.toLowerCase().includes(query)).slice(0, 12);
}

export function promptSkill(skills: SkillChoice[], text: string): SkillChoice | undefined {
  const name = /^\/([^\s/]+)(?:\s|$)/.exec(text)?.[1];
  return skills.find((skill) => skill.name === name);
}
