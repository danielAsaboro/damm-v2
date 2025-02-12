pub mod alpha_vault {
    use anchor_lang::prelude::Pubkey;
    use anchor_lang::solana_program::declare_id;

    #[cfg(not(feature = "test-bpf"))]
    declare_id!("vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2");

    #[cfg(feature = "test-bpf")]
    declare_id!("SNPmGgnywBvvrAKMLundzG6StojyHTHDLu7T4sdhP4k");

    pub fn derive_vault_pubkey(vault_base: Pubkey, pool: Pubkey) -> Pubkey {
        let (vault_pk, _) = Pubkey::find_program_address(
            &[b"vault", vault_base.as_ref(), pool.as_ref()],
            &self::ID,
        );
        vault_pk
    }
}
