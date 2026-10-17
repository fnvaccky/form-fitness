'use strict';
// UI-001: My membership → "Explore your next cycle", for a member with a paid current or upcoming cycle.
// - Above the cards: which plan they're on, until when, and when a next cycle would start.
// - The current plan's card says "Your current plan" (in place of its marketing badge) and offers "Renew <plan>";
//   the others offer "Switch to <plan> next cycle".
// - If an unpaid next cycle or invoice already exists, Pay now for it instead of picking another.
// Members with no plan, or no paid cycle, keep the plain "Select" wording. The server decides; this only renders.

// The member's latest fully paid cycle that is current or still to come, and any unpaid one waiting after today.
function nextCycleInfo(member) {
  const own = state.invoices.filter(i => i.memberId === member.id && i.end >= DEMO_DATE);
  const paid = own.filter(i => i.paidCents >= i.amountCents).sort((a, b) => a.end.localeCompare(b.end)).at(-1);
  if (!paid) return null;
  const waiting = own.filter(i => i.paidCents < i.amountCents).sort((a, b) => a.start.localeCompare(b.start))[0];
  // Task 12A: the plan as the member bought it; renewing (below) offers the catalog plan as it is now.
  return {plan: termsOf(paid), paidStart: paid.start, until: paid.end, next: addDays(paid.end, 1), waiting};
}

{
  const nextCycleBaseMembership = memberMembership;
  memberMembership = function() {
    const html = nextCycleBaseMembership(), member = memberById(selectedMember), info = member && nextCycleInfo(member);
    const start = html.indexOf('<div class="plan-intro">'), end = html.indexOf('<div class="info-strip">', start);
    if (!info || start < 0 || end < 0) return html;
    // The note goes above the cards, and above Task 12B's recommendation when there is one.
    const above = html.slice(start, end).includes('<div class="plan-recommendation') ? '<div class="plan-recommendation' : '<section class="plans-grid"';
    // The current plan's card says so, in place of its marketing badge, in both states below.
    let cards = html.slice(start, end).replace(/<article class="plan-card([^"]*)">([\s\S]*?)<\/article>/g, (card, cls, inner) => {
      if (!inner.includes(`data-plan="${info.plan.id}"`)) return card;
      const label = info.paidStart > DEMO_DATE ? 'Your upcoming paid plan' : 'Your current plan';
      inner = inner.replace(/<span class="tag">[\s\S]*?<\/span>/, '').replace(/(<div class="plan-kicker">[\s\S]*?)<\/div>/, `$1<span class="tag current-plan">${label}</span></div>`);
      return `<article class="plan-card${cls} current-plan">${inner}</article>`;
    });
    if (info.waiting) {
      // Pay for the next cycle first; the cards stay for reference, without their buttons.
      const plan = termsOf(info.waiting);
      const pay = can('initiateOnlinePayment') ? btn('Pay now', 'pay', 'primary', `data-id="${esc(info.waiting.id)}"`, 'arrow') : '<span>Pay at the front desk.</span>';
      cards = cards.replace(/<button class="button[^"]*" data-action="select-plan"[^>]*>[\s\S]*?<\/button>/g, '');
      const waiting = `<div class="next-cycle-note waiting" role="status"><p>Your next cycle (${esc(plan.name)}, from ${date(info.waiting.start, true)}) is waiting for payment.</p>${pay}</div>`;
      return html.slice(0, start) + cards.replace(above, waiting + above) + html.slice(end);
    }
    // Renew the current plan, or switch for the next cycle.
    for (const p of plans) cards = cards.replace(`Select ${esc(p.name)}</button>`, `${esc(p.id === info.plan.id ? `Renew ${p.name}` : `Switch to ${p.name} next cycle`)}</button>`);
    const paidCycle = info.paidStart > DEMO_DATE
      ? `Your paid ${esc(info.plan.name)} cycle runs from ${date(info.paidStart)} to ${date(info.until)}.`
      : `You’re on ${esc(info.plan.name)} until ${date(info.until)}.`;
    const note = `<div class="next-cycle-note" role="note"><p>${paidCycle} Choosing a plan below creates your next cycle, starting ${date(info.next, true)}; your current one isn’t affected.</p></div>`;
    return html.slice(0, start) + cards.replace(above, note + above) + html.slice(end);
  };
}
