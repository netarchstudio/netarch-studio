# NetArch Studio

Application web pour dessiner l'architecture d'un système d'information (routeurs, pare-feu, switchs, serveurs, liens, VLAN), avec un catalogue d'équipements et une liaison GLPI.

Deux conteneurs Docker, reliés par un réseau interne :

| Conteneur | Rôle | Port |
|---|---|---|
| `netarch-db` | MySQL 8.4, base de l'application (volume `db_data`) | non publié |
| `netarch-app` | Serveur Node.js + interface web | 3737 |

## Démarrage

Prérequis : Docker Desktop (ou Docker Engine + Compose v2).

```bash
cp .env.example .env        # puis éditer .env : choisir les mots de passe
docker compose up -d --build
```

Ouvrir http://localhost:3737. Au premier lancement, MySQL met 20 à 30 secondes à démarrer ; l'application attend qu'il soit prêt.

Commandes utiles :

```bash
docker compose logs -f app      # journaux de l'application
docker compose ps               # état des 2 conteneurs
docker compose down             # arrêt (les données restent dans le volume)
docker compose down -v          # arrêt ET suppression des données (irréversible)
```

## Reprendre les données de l'ancienne version (SQLite)

1. Placer l'ancienne base dans `./data/netarch.db`.
2. Démarrer MySQL puis lancer la migration (une seule fois) :

```bash
docker compose up -d db
docker compose --profile migrate run --rm migrate
docker compose up -d --build
```

Le schéma, l'historique, les réglages GLPI (adresse et jetons) et le catalogue sont copiés. L'ancien fichier n'est pas modifié.

## Sauvegarde de la base

```bash
docker compose exec db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" netarch' > sauvegarde.sql
```

## Liaison GLPI

Les réglages (adresse, port, jetons) se saisissent dans l'application (« Paramétrer GLPI ») et sont stockés dans MySQL, jamais dans le code ni dans Git. Les équipements cochés alimentent le catalogue.

## Sécurité

- L'application n'a pas d'authentification : ne l'exposez pas sur Internet.
- Ne publiez jamais `.env` ni le dossier `data/` (déjà exclus par `.gitignore`).
- Les jetons GLPI sont enregistrés en clair dans la base MySQL : protégez l'accès au volume et aux sauvegardes.

## Publier sur GitHub

```bash
git init
git add .
git status                  # vérifier que .env et data/ n'apparaissent PAS
git commit -m "NetArch Studio : Docker + MySQL"
git branch -M main
git remote add origin https://github.com/<utilisateur>/<depot>.git
git push -u origin main
```

Facultatif : lancez `npm install` une fois sur votre PC (Node.js requis) pour créer `package-lock.json`, et ajoutez-le au dépôt pour des installations reproductibles.

## Déploiement sur un serveur CentOS (images publiées sur GitHub)

Principe : `git push` -> GitHub construit l'image -> le serveur CentOS la télécharge et la lance.

### 1. Publication de l'image (automatique)
Le fichier `.github/workflows/docker-publish.yml` construit et publie l'image dans GitHub Container Registry à chaque push sur `main`. Elle se retrouve dans l'onglet **Packages** du dépôt, sous le nom `ghcr.io/<utilisateur>/<depot>:latest` (en minuscules).

### 2. Installer Docker sur le serveur CentOS (une seule fois, avec sudo)
```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo docker compose version
```
Ouvrir le port de l'application, pour le réseau interne seulement :
```bash
sudo firewall-cmd --permanent --add-port=3737/tcp && sudo firewall-cmd --reload
```

### 3. Lancer l'application sur le serveur
Sur le serveur, récupérer uniquement `docker-compose.prod.yml` et `.env.example` (ou `git clone` du dépôt), puis :
```bash
cp .env.example .env && nano .env     # mots de passe + APP_IMAGE
# Si le paquet GitHub est privé : se connecter une fois avec un jeton GitHub (droit read:packages)
echo "<JETON>" | sudo docker login ghcr.io -u <utilisateur> --password-stdin
sudo docker compose -f docker-compose.prod.yml up -d
```
Ouvrir ensuite `http://<adresse-du-serveur>:3737`.

### 4. Mettre à jour l'application
Après un nouveau `git push`, attendre la fin de la construction (onglet **Actions** du dépôt), puis sur le serveur :
```bash
sudo docker compose -f docker-compose.prod.yml pull
sudo docker compose -f docker-compose.prod.yml up -d
```
Les données MySQL restent dans le volume `db_data`.
