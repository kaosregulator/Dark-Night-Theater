// Friendly reminder after `npm install`. Kept intentionally trivial so install
// never fails because of it.
try {
  console.log('\n✅ Dependencies installed for DarkNight Home Theater.');
  console.log('   Next: copy .env.example -> .env and fill in your secrets,');
  console.log('   then run:  npm run build  &&  npm start');
  console.log('   (register slash commands once with: npm run register)\n');
} catch {
  /* no-op */
}
