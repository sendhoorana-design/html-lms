// Seeds a default admin account. Run once: npm run seed
const bcrypt = require('bcryptjs');
const { connectDB, mongoose } = require('./db');
const User = require('./models/User');

async function main() {
  await connectDB();

  const existing = await User.findOne({ username: 'admin' });
  if (existing) {
    console.log('User "admin" already exists, skipping.');
    // Backfill: an "admin" created by an older version of this script won't have
    // is_super_admin set. Running seed again after upgrading fixes that in place.
    if (!existing.is_super_admin) {
      await User.updateOne({ _id: existing._id }, { $set: { is_super_admin: true, admin_status: 'approved' } });
      console.log('Marked existing "admin" account as the main/super admin.');
    }
  } else {
    const hash = bcrypt.hashSync('admin123', 10);
    await User.create({
      username: 'admin',
      password_hash: hash,
      role: 'admin',
      full_name: 'Default Admin',
      is_super_admin: true,
      admin_status: 'approved'
    });
    console.log('Created admin: admin / admin123 (main/super admin)');
  }

  console.log('\nSeed complete. Log in at /login.html with the credentials above.');
  console.log('IMPORTANT: change the default admin password after first login (create a new admin user and retire this one, or update the record directly).');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  console.error('Make sure MongoDB is reachable — check MONGODB_URI in .env (local mongod running, or a valid Atlas connection string).');
  process.exit(1);
});
