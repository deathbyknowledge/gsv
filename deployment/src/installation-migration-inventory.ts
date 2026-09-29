export type InstallationMigrationOwner = "directory" | "policy";

export type InstallationMigrationSource = {
  name: string;
  owner: InstallationMigrationOwner;
  sha256: string;
};

// These are source fingerprints, not evidence that a particular database applied
// the files. Private SQL and its routing/policy seeds remain with their owner.
export const installationMigrationInventory: readonly InstallationMigrationSource[] = [
  { name: "0001_account_directory.sql", owner: "directory", sha256: "84f01053c30272330301bb0ef3181e894aa561659a550484680c113f494c3ee1" },
  { name: "0002_installation_onboarding.sql", owner: "directory", sha256: "7b117cc3be84a1802345e20b23b271968d25512249c2b2c559be7ee680f40d73" },
  { name: "0003_managed_inference_usage.sql", owner: "policy", sha256: "05e7853bb061f9781b9f57a6b526214c865d93f92d70482dd3f03fa5961467b5" },
  { name: "0004_managed_inference_policy.sql", owner: "policy", sha256: "2ee5ba2dfb82fbfe976d4112b816c129eac6b6d3ca401b9e1cb06f9caeaa3f94" },
  { name: "0005_managed_inference_purpose.sql", owner: "policy", sha256: "80f05bea81907b27ffd8303b3f33d85b37a695473870828198bc0d1e7b6fa98e" },
  { name: "0006_add_installation_resets.sql", owner: "directory", sha256: "1aa8b31bac2f702b8af1ab0ea3144edaa6a474ea2a7a66af64a73502ecad4a7f" },
  { name: "0007_managed_inference_routing.sql", owner: "policy", sha256: "829a65c54f3042a5d631aaf7a7c3873f1974274803cb49dc43242e7f45abeb01" },
  { name: "0008_workers_ai_inference.sql", owner: "policy", sha256: "6ecf3c3a9bf9677ea66cc6c150971757131dc8947e4201117fcfce0fa5d818ef" },
  { name: "0009_managed_inference_fallbacks.sql", owner: "policy", sha256: "3413bda42fff8195aa826a2b3c6aa624f8b62cfac490643844b216c885ddcf96" },
  { name: "0010_prepare_membership_ownership.sql", owner: "directory", sha256: "6903c58c856f1b00e9159faf5733ba1f4af43ce1916483d6b0722c0c5ae5747f" },
  { name: "0011_installation_reset_preparations.sql", owner: "directory", sha256: "396b79594437c3a238a488069a53fbbc657fe57ae2b1694bc293dbc3f99abda8" },
  { name: "0012_inference_reset_receipts.sql", owner: "policy", sha256: "28bbd5aaeb9099ee9d3b5c1e3d406ffd954ac6f4bb651010bae2be0d5054f607" },
];
