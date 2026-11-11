import { Variants } from "@iterbar/react";

function CalmHero() {
  return <h1 id="hero">Ship small changes, see them at once</h1>;
}

function BoldHero() {
  return <h1 id="hero">SHIP IT. SEE IT. NOW.</h1>;
}

function PricingTable() {
  return (
    <table id="pricing">
      <tbody>
        <tr><th scope="row">Starter</th><td>$9</td></tr>
        <tr><th scope="row">Team</th><td>$29</td></tr>
      </tbody>
    </table>
  );
}

function PricingCards() {
  return (
    <ul id="pricing">
      <li>Starter: $9</li>
      <li>Team: $29</li>
    </ul>
  );
}

/** One page, two slots. In `vite dev` the Iterbar bar switches between their versions. */
export function App() {
  return (
    <main>
      <Variants slot="hero" versions={{ calm: CalmHero, bold: BoldHero }} default="calm" />
      <Variants slot="pricing" versions={{ table: PricingTable, cards: PricingCards }} default="table" />
    </main>
  );
}
